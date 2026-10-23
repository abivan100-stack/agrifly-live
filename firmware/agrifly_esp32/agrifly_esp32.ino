/*
  AgriFly ESP32 sensor payload
    Blynk (default): writes V0 = IR sensor (0/1) on change, and V10 = this board's local IP on every connect.
    Local Wi-Fi:     serves GET http://<this-ip>/data (also http://agrifly.local/data via mDNS).
                     It only answers when asked; the AgriFly server polls it while a dashboard shows "Local Wi-Fi".

  Board: "ESP32 Dev Module" (Boards Manager: "esp32" by Espressif Systems)
  Library: "Blynk" by Volodymyr Shymanskyy. WiFi, WebServer and ESPmDNS come with the ESP32 core.

  Setup: copy secrets.example.h to secrets.h and fill in the Blynk IDs/token and Wi-Fi.
  Blynk datastreams: V0 integer 0-1 (IR), V10 string (ESP IP).

  Wiring (testing now):
    IR obstacle sensor: VCC -> 3V3, GND -> GND, OUT -> GPIO 27
    Most IR modules pull OUT LOW when an object is in front.

  How to add a sensor (example: temperature on V1):
    1. Blynk console: add a datastream, Virtual Pin V1, type Double.
    2. Here: read it, send it to Blynk (like V0 in checkIR()), and add it to the JSON in handleData():
         Blynk.virtualWrite(V1, temperature);
         ...\"temperature\":{\"value\":<temperature>,\"unit\":\"°C\"}...
    3. config/sensors.json on the server: add
         { "key": "temperature", "blynkPin": "v1", "label": "Temperature", "unit": "°C", "type": "number" }
    The dashboard shows the new card by itself; no website code changes.
*/

// ===================== CONFIG =====================
#include "secrets.h"        // Blynk template ID/name/token, BLYNK_SERVER, Wi-Fi (gitignored)
#define BLYNK_PRINT Serial

char ssid[] = WIFI_SSID;      // 2.4 GHz
char pass[] = WIFI_PASSWORD;

const char* DEVICE_ID = "agrifly-01";
const int IR_PIN = 27;
// ==================================================

#include <WiFi.h>
#include <WiFiClient.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <BlynkSimpleEsp32.h>

BlynkTimer timer;
WebServer localServer(80);   // only answers when the website asks (Local Wi-Fi mode)

int irState = -1;
int lastSentBlynk = -1;
bool mdnsStarted = false;

int readIR() {
  return (digitalRead(IR_PIN) == LOW) ? 1 : 0;   // most IR modules go LOW on detect
}

// ---------- Blynk (default) ----------
void sendIP() {
  if (Blynk.connected()) Blynk.virtualWrite(V10, WiFi.localIP().toString());   // tell website our local IP
}

BLYNK_CONNECTED() {
  lastSentBlynk = -1;   // resend current value
  sendIP();
  Serial.println("[Blynk] connected, IP sent to V10");
}

void checkIR() {
  irState = readIR();
  if (irState != lastSentBlynk && Blynk.connected()) {
    Blynk.virtualWrite(V0, irState);                    // only on change: saves quota
    lastSentBlynk = irState;
    Serial.printf("[Blynk] V0 = %d\n", irState);
  }
}

// ---------- Local Wi-Fi (on request only) ----------
void handleData() {
  String json = String("{\"device\":\"") + DEVICE_ID +
                "\",\"readings\":{\"ir\":{\"value\":" + irState +
                ",\"unit\":\"\"}},\"uptime\":" + (millis() / 1000) + "}";
  localServer.sendHeader("Access-Control-Allow-Origin", "*");
  localServer.send(200, "application/json", json);
}

void handleRoot() {
  localServer.send(200, "text/plain", "AgriFly ESP32 is running. Data at /data");
}

void startMDNS() {
  if (!mdnsStarted && WiFi.status() == WL_CONNECTED && MDNS.begin("agrifly")) {
    MDNS.addService("http", "tcp", 80);
    mdnsStarted = true;
    Serial.println("[Local] reachable at http://agrifly.local/data");
  }
}

void checkWiFi() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] lost, reconnecting...");
    WiFi.reconnect();
  } else {
    startMDNS();
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(IR_PIN, INPUT);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, pass);
  Serial.print("[WiFi] connecting");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[WiFi] connected, ESP32 IP: ");
    Serial.println(WiFi.localIP());
    startMDNS();
  }

  localServer.on("/", handleRoot);
  localServer.on("/data", handleData);
  localServer.begin();

  Blynk.config(BLYNK_AUTH_TOKEN, BLYNK_SERVER, 80);
  Blynk.connect(5000);

  timer.setInterval(200L,   checkIR);
  timer.setInterval(10000L, checkWiFi);
  timer.setInterval(300000L, sendIP);   // every 5 min: covers a V10 added after connect, or a new IP
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) Blynk.run();
  localServer.handleClient();
  timer.run();
}
