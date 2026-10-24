/*
  AgriFly ESP32 sensor payload
    Blynk (default): writes
        V0  = IR sensor (0/1), on change
        V6  = MQ-135 gas sensor level (raw ADC 0-4095)
        V7  = MPU6050 tilt (degrees from level, 0-180)
        V10 = this board's local IP, on every connect
    Local Wi-Fi:     serves GET http://<this-ip>/data (also http://agrifly.local/data via mDNS).
                     It only answers when asked; the AgriFly server polls it while a dashboard shows "Local Wi-Fi".

  Board: "ESP32 Dev Module" (Boards Manager: "esp32" by Espressif Systems)
  Libraries: "Blynk" by Volodymyr Shymanskyy, and "Adafruit MPU6050" (let it install Adafruit BusIO and
             Adafruit Unified Sensor too). WiFi, WebServer, ESPmDNS and Wire come with the ESP32 core.

  Setup: copy secrets.example.h to secrets.h and fill in the Blynk IDs/token and Wi-Fi.
  Blynk datastreams (template): V0 Integer 0-1, V6 Integer 0-4095, V7 Double 0-180, V10 String.

  Wiring:
    IR obstacle sensor: VCC -> 3V3, GND -> GND, OUT -> GPIO 27
    MPU6050 (GY-521):   VCC -> 3V3, GND -> GND, SDA -> GPIO 21, SCL -> GPIO 22, AD0 -> GND
    MQ-135:             VCC -> VIN (5 V), GND -> GND, AO -> 10 kOhm -> GPIO 35 -> 20 kOhm -> GND
                        (the divider keeps the 5 V sensor output safe for the ESP32 pin)

  Notes:
    - Tilt is 0 when the MPU6050 board lies flat with its Z axis up, and 180 when it is upside down.
    - The MQ-135 heater needs time to warm up, so gas is not published for the first GAS_WARMUP_MS.
      The value is a raw sensor level, not ppm: show it as a trend.
    - Blynk messages are limited, so V6/V7 are only sent when they change enough, plus once a minute.

  How to add a sensor (example: temperature on V1):
    1. Blynk console: add a datastream, Virtual Pin V1, type Double.
    2. Here: read it, send it to Blynk (like V6 in pushSensors()), and add it to the JSON in handleData():
         Blynk.virtualWrite(V1, temperature);
         ...\"temperature\":{\"value\":<temperature>,\"unit\":\"\\u00b0C\"}...
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
const int IR_PIN  = 27;
const int GAS_PIN = 35;       // ADC1 pin, input only: works while Wi-Fi is on
const int I2C_SDA = 21;
const int I2C_SCL = 22;

// MQ-135
const uint32_t GAS_WARMUP_MS = 120000UL;   // do not publish gas until the heater has warmed up
const int      GAS_SAMPLES   = 16;         // ADC readings averaged per reading

// How readings are read and pushed to Blynk
const uint32_t SENSOR_READ_MS    = 1000;    // read gas + tilt (also feeds the local /data page)
const uint32_t SENSOR_PUSH_MS    = 5000;    // check whether to send to Blynk
const uint32_t SENSOR_REFRESH_MS = 60000;   // send even if unchanged, so the dashboard stays fresh
const int      GAS_DEADBAND      = 15;      // raw counts that must change before sending
const float    TILT_DEADBAND     = 1.0f;    // degrees that must change before sending
// ==================================================

#include <WiFi.h>
#include <WiFiClient.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <BlynkSimpleEsp32.h>

BlynkTimer timer;
WebServer localServer(80);   // only answers when the website asks (Local Wi-Fi mode)
Adafruit_MPU6050 mpu;

int irState = -1;
int lastSentBlynk = -1;
bool mdnsStarted = false;

// MPU6050 (tilt)
bool  mpuOk = false;         // sensor answered on the I2C bus
bool  tiltValid = false;     // we have a good tilt value
float tiltDeg = 0;
int   mpuFails = 0;

// MQ-135 (gas)
bool gasReady = false;       // warm-up finished
int  gasRaw = 0;

// what was last sent to Blynk
int      lastSentGas  = -1;
float    lastSentTilt = -1000.0f;
uint32_t lastSensorSendMs = 0;

int readIR() {
  return (digitalRead(IR_PIN) == LOW) ? 1 : 0;   // most IR modules go LOW on detect
}

// ---------- MQ-135 ----------
int readGasAveraged() {
  long sum = 0;
  for (int i = 0; i < GAS_SAMPLES; i++) {
    sum += analogRead(GAS_PIN);
    delayMicroseconds(200);
  }
  return (int)(sum / GAS_SAMPLES);
}

// ---------- MPU6050 ----------
bool startMpu() {
  if (!mpu.begin()) return false;                 // default address 0x68 (AD0 -> GND)
  mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  return true;
}

// Tilt = angle between the sensor's Z axis and straight up, from the average of 10 accelerometer readings.
bool readTilt(float &deg) {
  const int N = 10;
  float sx = 0, sy = 0, sz = 0;
  for (int i = 0; i < N; i++) {
    sensors_event_t a, g, t;
    mpu.getEvent(&a, &g, &t);
    sx += a.acceleration.x;
    sy += a.acceleration.y;
    sz += a.acceleration.z;
    delay(2);
  }
  float ax = sx / N, ay = sy / N, az = sz / N;
  float mag = sqrtf(ax * ax + ay * ay + az * az);   // about 9.8 m/s^2 when the board is not accelerating
  if (!(mag > 3.0f)) return false;                  // all-zero or garbage data: sensor not really answering
  deg = atan2f(sqrtf(ax * ax + ay * ay), az) * 180.0f / PI;
  return true;
}

void readSensors() {
  if (!gasReady && millis() >= GAS_WARMUP_MS) {
    gasReady = true;
    Serial.println("[Gas] warm-up finished, publishing readings");
  }
  if (gasReady) gasRaw = readGasAveraged();

  static uint32_t lastMpuTry = 0;
  if (!mpuOk && millis() - lastMpuTry >= 30000UL) {   // sensor missing: try again every 30 s
    lastMpuTry = millis();
    if (startMpu()) {
      mpuOk = true;
      mpuFails = 0;
      Serial.println("[MPU] found");
    }
  }
  if (mpuOk) {
    float d;
    if (readTilt(d)) {
      tiltDeg = d;
      tiltValid = true;
      mpuFails = 0;
    } else if (++mpuFails >= 5) {                     // 5 bad reads in a row
      mpuOk = false;
      tiltValid = false;
      Serial.println("[MPU] lost, will retry every 30 s");
    }
  }
}

// ---------- Blynk (default) ----------
void sendIP() {
  if (Blynk.connected()) Blynk.virtualWrite(V10, WiFi.localIP().toString());   // tell website our local IP
}

BLYNK_CONNECTED() {
  lastSentBlynk = -1;   // resend current values
  lastSentGas   = -1;
  lastSentTilt  = -1000.0f;
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

void pushSensors() {
  if (!Blynk.connected()) return;
  uint32_t now = millis();
  bool refresh = (now - lastSensorSendMs) >= SENSOR_REFRESH_MS;

  if (gasReady && (refresh || lastSentGas < 0 || abs(gasRaw - lastSentGas) >= GAS_DEADBAND)) {
    Blynk.virtualWrite(V6, gasRaw);
    lastSentGas = gasRaw;
    Serial.printf("[Blynk] V6 gas = %d\n", gasRaw);
  }
  if (tiltValid && (refresh || lastSentTilt < -500.0f || fabsf(tiltDeg - lastSentTilt) >= TILT_DEADBAND)) {
    float rounded = roundf(tiltDeg * 10.0f) / 10.0f;
    Blynk.virtualWrite(V7, rounded);
    lastSentTilt = tiltDeg;
    Serial.printf("[Blynk] V7 tilt = %.1f\n", rounded);
  }
  if (refresh) lastSensorSendMs = now;
}

// ---------- Local Wi-Fi (on request only) ----------
void handleData() {
  String json = String("{\"device\":\"") + DEVICE_ID +
                "\",\"readings\":{\"ir\":{\"value\":" + irState + ",\"unit\":\"\"}";
  if (gasReady)  json += String(",\"gas\":{\"value\":") + gasRaw + ",\"unit\":\"ADC\"}";
  if (tiltValid) json += String(",\"tilt\":{\"value\":") + String(tiltDeg, 1) + ",\"unit\":\"\\u00b0\"}";
  json += String("},\"uptime\":") + (millis() / 1000) + "}";
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

  pinMode(GAS_PIN, INPUT);
  analogReadResolution(12);                       // 0-4095
  analogSetPinAttenuation(GAS_PIN, ADC_11db);     // full 0-3.3 V range

  Wire.begin(I2C_SDA, I2C_SCL);
  mpuOk = startMpu();
  Serial.println(mpuOk ? "[MPU] found" : "[MPU] not found - check wiring (SDA 21, SCL 22, AD0 to GND)");

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
  timer.setInterval((long)SENSOR_READ_MS, readSensors);
  timer.setInterval((long)SENSOR_PUSH_MS, pushSensors);
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) Blynk.run();
  localServer.handleClient();
  timer.run();
}
