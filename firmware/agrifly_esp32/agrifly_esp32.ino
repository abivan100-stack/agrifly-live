/*
  AgriFly ESP32 sensor payload
  Sends readings two ways at the same time:
    1. Blynk Cloud (virtual pins) - works from any network; the AgriFly server reads them from Blynk.
    2. Local Wi-Fi - POSTs JSON to the AgriFly laptop server every 2 s (same network only).

  Board: "ESP32 Dev Module" (Boards Manager: "esp32" by Espressif Systems)
  Library: "Blynk" by Volodymyr Shymanskyy (Library Manager). WiFi and HTTPClient come with the ESP32 core.

  Setup: copy secrets.example.h to secrets.h and fill in the Blynk IDs/token, Wi-Fi and LOCAL_URL.

  Wiring (testing now):
    IR obstacle sensor: VCC -> 3V3, GND -> GND, OUT -> GPIO 27 (change IR_PIN below if yours differs)
    Most IR modules pull OUT LOW when an object is in front (IR_ACTIVE_LOW = true).

  How to add a sensor (example: temperature on V1):
    1. Blynk console: add a datastream, Virtual Pin V1, type Double.
    2. Here, in sendReadings(): read it, then add ONE line for each destination:
         Blynk.virtualWrite(V1, temperature);
         addLocal(json, "temperature", temperature, "°C");
    3. config/sensors.json on the server: add
         { "key": "temperature", "blynkPin": "v1", "label": "Temperature", "unit": "°C", "type": "number" }
    The dashboard shows the new card by itself; no website code changes.
*/

#include "secrets.h"        // must come before BlynkSimpleEsp32.h (it defines the BLYNK_TEMPLATE_* values)
#define BLYNK_PRINT Serial
#include <WiFi.h>
#include <HTTPClient.h>
#include <BlynkSimpleEsp32.h>

// ---------- settings ----------
const char*    DEVICE_ID          = "agrifly-01";
const int      IR_PIN             = 27;
const bool     IR_ACTIVE_LOW      = true;
const uint32_t READ_INTERVAL_MS   = 200;     // how often the IR pin is checked
const uint32_t BLYNK_REFRESH_MS   = 10000;   // resend to Blynk at least this often (changes are sent at once)
const uint32_t LOCAL_INTERVAL_MS  = 2000;
const uint32_t WIFI_RETRY_MS      = 10000;

BlynkTimer timer;
int  irValue = -1;          // -1 = not read yet
bool wasConnected = false;
uint32_t lastBlynkSend = 0, lastWifiTry = 0;

int readIr() {
  int level = digitalRead(IR_PIN);
  return IR_ACTIVE_LOW ? (level == LOW) : (level == HIGH);
}

// ---------- local Wi-Fi: build {"readings":{...}} one sensor at a time ----------
void addLocal(String& json, const char* key, float value, const char* unit) {
  if (isnan(value)) return;                 // skip a failed reading instead of sending 0
  if (!json.endsWith("{")) json += ",";
  json += "\""; json += key; json += "\":{\"value\":"; json += String(value, 2);
  json += ",\"unit\":\""; json += unit; json += "\"}";
}

void postLocal() {
  if (strlen(LOCAL_URL) == 0 || WiFi.status() != WL_CONNECTED || irValue < 0) return;
  String json = "{\"device\":\""; json += DEVICE_ID;
  json += "\",\"token\":\""; json += LOCAL_TOKEN;
  json += "\",\"readings\":{";
  addLocal(json, "ir", irValue, "");
  // addLocal(json, "temperature", temperature, "°C");   <- new sensors go here
  json += "}}";

  HTTPClient http;
  http.setTimeout(1500);                    // short, so Blynk keeps running if the laptop is unreachable
  http.begin(LOCAL_URL);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(json);
  if (code != 200) Serial.printf("Local POST %d %s\n", code, code < 0 ? http.errorToString(code).c_str() : "");
  http.end();
}

// ---------- Blynk ----------
void sendBlynk() {
  if (!Blynk.connected() || irValue < 0) return;
  Blynk.virtualWrite(V0, irValue);
  // Blynk.virtualWrite(V1, temperature);                 <- new sensors go here
  lastBlynkSend = millis();
}

void checkIr() {
  int v = readIr();
  bool changed = v != irValue;
  irValue = v;
  if (changed) {
    Serial.printf("IR: %s\n", irValue ? "object detected" : "clear");
    sendBlynk();                            // changes go out immediately
  } else if (millis() - lastBlynkSend >= BLYNK_REFRESH_MS) {
    sendBlynk();                            // otherwise a slow refresh, to save Blynk message quota
  }
}

// ---------- Wi-Fi without blocking ----------
void handleWifi() {
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected && !wasConnected) { Serial.print("Wi-Fi connected, IP "); Serial.println(WiFi.localIP()); }
  if (!connected && wasConnected) Serial.println("Wi-Fi lost, reconnecting...");
  wasConnected = connected;
  if (!connected && millis() - lastWifiTry >= WIFI_RETRY_MS) {
    lastWifiTry = millis();
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nAgriFly ESP32 starting");
  pinMode(IR_PIN, INPUT);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  lastWifiTry = millis();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);     // don't wait here; loop() keeps reading sensors without Wi-Fi
  Blynk.config(BLYNK_AUTH_TOKEN, BLYNK_SERVER, 80);

  timer.setInterval(READ_INTERVAL_MS, checkIr);
  timer.setInterval(LOCAL_INTERVAL_MS, postLocal);
}

void loop() {
  handleWifi();
  if (WiFi.status() == WL_CONNECTED) Blynk.run();   // connects to Blynk by itself once Wi-Fi is up
  timer.run();
}
