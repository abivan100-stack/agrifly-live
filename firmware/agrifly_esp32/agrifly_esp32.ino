/*
  AgriFly ESP32 sensor payload
  Reads the sensors and POSTs JSON to the AgriFly laptop server every 2 s.

  Board: "ESP32 Dev Module" (Boards Manager: "esp32" by Espressif Systems)

  Libraries (Library Manager):
    - ArduinoJson          by Benoit Blanchon   (v7)
    - Adafruit BME280 Library  (also installs Adafruit Unified Sensor)
    - BH1750               by Christopher Laws
    - TinyGPSPlus          by Mikal Hart
    WiFi, HTTPClient, Wire come with the ESP32 core.

  Wiring (ESP32 DevKit V1):
    BME280  (temp/humidity/pressure)  I2C  SDA -> GPIO 21, SCL -> GPIO 22, 3V3, GND
    BH1750  (light)                   same I2C bus (SDA 21 / SCL 22), 3V3, GND
    Soil moisture sensor              analog out -> GPIO 34
    MQ gas sensor                     analog out -> GPIO 35 (use a divider if the module outputs 5 V)
    NEO-6M GPS                        GPS TX -> GPIO 16 (ESP32 RX2), GPS RX -> GPIO 17 (ESP32 TX2), 9600 baud

  Setup: copy secrets.example.h to secrets.h and fill in Wi-Fi, server URL and token.

  Adding a sensor: read it in readAndAddSensors() and add ONE line:
      addReading("co2", co2Value, "ppm");
  The dashboard creates a card for it automatically.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <BH1750.h>
#include <TinyGPSPlus.h>
#include <ArduinoJson.h>
#include "secrets.h"

// ---------- settings ----------
#define ENABLE_THINGSPEAK 0                    // 1 = also upload to ThingSpeak
const char*    DEVICE_ID            = "agrifly-01";
const uint32_t SEND_INTERVAL_MS     = 2000;
const uint32_t THINGSPEAK_INTERVAL_MS = 20000; // ThingSpeak free tier: minimum 15 s
const uint32_t WIFI_RETRY_MS        = 10000;
const uint32_t SENSOR_RETRY_MS      = 10000;   // retry a sensor that failed begin()
const uint32_t GPS_MAX_AGE_MS       = 5000;    // older fix = treat as no fix

// Soil calibration: read the raw value in dry air and in a cup of water, put them here.
const int SOIL_RAW_DRY = 3500;
const int SOIL_RAW_WET = 1500;

// ---------- pins ----------
const int PIN_SDA = 21, PIN_SCL = 22;
const int PIN_SOIL = 34, PIN_GAS = 35;
const int PIN_GPS_RX = 16, PIN_GPS_TX = 17;

// ---------- sensors ----------
Adafruit_BME280 bme;
BH1750 lightMeter;
TinyGPSPlus gps;
HardwareSerial gpsSerial(2);
bool bmeOk = false, lightOk = false;

JsonDocument doc;
JsonObject readings;

uint32_t lastSend = 0, lastWifiTry = 0, lastSensorRetry = 0, lastThingSpeak = 0;
bool wasConnected = false;

// Latest values kept for the optional ThingSpeak upload (NAN = not available)
float tsTemp = NAN, tsHum = NAN, tsPres = NAN, tsLux = NAN, tsSoil = NAN, tsGas = NAN;

void addReading(const char* key, float value, const char* unit) {
  if (isnan(value) || isinf(value)) return;  // skip a failed reading instead of sending 0
  JsonObject r = readings[key].to<JsonObject>();
  r["value"] = roundf(value * 100) / 100;
  r["unit"] = unit;
}

void startSensors() {
  if (!bmeOk) {
    bmeOk = bme.begin(0x76) || bme.begin(0x77);
    Serial.println(bmeOk ? "BME280 OK" : "BME280 not found - skipping temp/humidity/pressure");
  }
  if (!lightOk) {
    lightOk = lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE);
    Serial.println(lightOk ? "BH1750 OK" : "BH1750 not found - skipping light");
  }
}

void readAndAddSensors() {
  tsTemp = tsHum = tsPres = tsLux = NAN;

  if (bmeOk) {
    tsTemp = bme.readTemperature();
    tsHum  = bme.readHumidity();
    tsPres = bme.readPressure() / 100.0F;
    addReading("temperature", tsTemp, "°C");
    addReading("humidity",    tsHum,  "%");
    addReading("pressure",    tsPres, "hPa");
  }

  if (lightOk) {
    float lux = lightMeter.readLightLevel();   // negative = read error
    if (lux >= 0) { tsLux = lux; addReading("light", lux, "lux"); }
  }

  int soilRaw = analogRead(PIN_SOIL);
  tsSoil = constrain(map(soilRaw, SOIL_RAW_DRY, SOIL_RAW_WET, 0, 100), 0, 100);
  addReading("soil", tsSoil, "% est.");

  tsGas = analogRead(PIN_GAS);
  addReading("gas_raw", tsGas, "ADC");
}

void addGps() {
  JsonObject g = doc["gps"].to<JsonObject>();
  bool valid = gps.location.isValid() && gps.location.age() < GPS_MAX_AGE_MS;
  g["valid"] = valid;
  if (valid) {
    g["lat"] = serialized(String(gps.location.lat(), 6));
    g["lon"] = serialized(String(gps.location.lng(), 6));
  }
}

void sendToServer() {
  doc.clear();
  doc["device"] = DEVICE_ID;
  doc["token"] = DEVICE_TOKEN;
  readings = doc["readings"].to<JsonObject>();
  readAndAddSensors();
  addGps();

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  http.setTimeout(3000);
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  if (code > 0) {
    Serial.printf("POST %d  %s\n", code, body.c_str());
    if (code != 200) Serial.println("  server said: " + http.getString());
  } else {
    Serial.printf("POST failed: %s (is the laptop server running at %s ?)\n",
                  http.errorToString(code).c_str(), SERVER_URL);
  }
  http.end();
}

#if ENABLE_THINGSPEAK
void sendToThingSpeak() {
  String url = "http://api.thingspeak.com/update?api_key=" THINGSPEAK_API_KEY;
  float fields[] = { tsTemp, tsHum, tsPres, tsLux, tsSoil, tsGas };  // field1..field6 - match your channel
  for (int i = 0; i < 6; i++) {
    if (!isnan(fields[i])) url += "&field" + String(i + 1) + "=" + String(fields[i], 2);
  }
  if (gps.location.isValid() && gps.location.age() < GPS_MAX_AGE_MS) {
    url += "&field7=" + String(gps.location.lat(), 6) + "&field8=" + String(gps.location.lng(), 6);
  }
  HTTPClient http;
  http.setTimeout(3000);
  http.begin(url);
  int code = http.GET();
  Serial.printf("ThingSpeak %d\n", code);
  http.end();
}
#endif

void handleWifi() {
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected && !wasConnected) {
    Serial.print("Wi-Fi connected, IP ");
    Serial.println(WiFi.localIP());
  }
  if (!connected && wasConnected) Serial.println("Wi-Fi lost, reconnecting...");
  wasConnected = connected;

  if (!connected && millis() - lastWifiTry >= WIFI_RETRY_MS) {
    lastWifiTry = millis();
    Serial.printf("Connecting to Wi-Fi \"%s\"...\n", WIFI_SSID);
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nAgriFly ESP32 starting");

  Wire.begin(PIN_SDA, PIN_SCL);
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);   // full 0-3.3 V range on GPIO 34/35
  gpsSerial.begin(9600, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
  startSensors();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  lastWifiTry = millis();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);   // don't wait here; loop() keeps going without Wi-Fi
}

void loop() {
  while (gpsSerial.available()) gps.encode(gpsSerial.read());

  handleWifi();

  if ((!bmeOk || !lightOk) && millis() - lastSensorRetry >= SENSOR_RETRY_MS) {
    lastSensorRetry = millis();
    startSensors();
  }

  if (millis() - lastSend >= SEND_INTERVAL_MS) {
    lastSend = millis();
    if (WiFi.status() == WL_CONNECTED) sendToServer();
  }

#if ENABLE_THINGSPEAK
  if (millis() - lastThingSpeak >= THINGSPEAK_INTERVAL_MS && WiFi.status() == WL_CONNECTED) {
    lastThingSpeak = millis();
    sendToThingSpeak();
  }
#endif
}
