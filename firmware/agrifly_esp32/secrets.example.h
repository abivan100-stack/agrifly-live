// Copy this file to secrets.h (same folder) and fill in your values.
// secrets.h is gitignored - never commit real passwords or API keys.
#pragma once

#define WIFI_SSID      "YOUR_WIFI_NAME"
#define WIFI_PASSWORD  "YOUR_WIFI_PASSWORD"

// Laptop running `npm start`. Use the IP the server prints on startup.
#define SERVER_URL     "http://192.168.1.100:3000/api/data"

// Must match AGRIFLY_TOKEN in the server's .env (default: change-me)
#define DEVICE_TOKEN   "change-me"

// Only used when ENABLE_THINGSPEAK is 1 in agrifly_esp32.ino
#define THINGSPEAK_API_KEY "YOUR_THINGSPEAK_WRITE_KEY"
