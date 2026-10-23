// Copy this file to secrets.h (same folder) and fill in your values.
// secrets.h is gitignored - never commit real tokens or passwords.
#pragma once

// From the Blynk console: Developer Zone -> your template / device -> Device Info
#define BLYNK_TEMPLATE_ID   "TMPLxxxxxxxxx"
#define BLYNK_TEMPLATE_NAME "AgriFly"
#define BLYNK_AUTH_TOKEN    "YOUR_BLYNK_DEVICE_AUTH_TOKEN"
#define BLYNK_SERVER        "blr1.blynk.cloud"   // your Blynk region

// 2.4 GHz Wi-Fi only (the ESP32 cannot join 5 GHz networks)
#define WIFI_SSID      "YOUR_WIFI_NAME"
#define WIFI_PASSWORD  "YOUR_WIFI_PASSWORD"

// Local Wi-Fi mode: the laptop running `npm start`. Copy the "ESP32 LOCAL_URL" line it prints.
// Leave LOCAL_URL empty ("") to send to Blynk only.
#define LOCAL_URL      "http://192.168.1.100:3000/api/data"
#define LOCAL_TOKEN    "change-me"   // must match LOCAL_TOKEN in the server's .env
