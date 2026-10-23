# AgriFly

**Smarter Technology for Smarter Farming** - Team 5 (Rokith Kumaar, Deepak Kumar, Adhithya), 2026-27.

AgriFly is an IoT field-monitoring system. An FPV drone carries an ESP32 sensor payload (temperature, humidity,
pressure, light, estimated soil moisture, gas sensor level and GPS). The ESP32 sends readings over Wi-Fi every
2 seconds to a small Node.js server on a laptop, and a live dashboard shows them on any laptop or phone on the
same network.

```
ESP32  --HTTP POST JSON every 2 s-->  Node server on laptop (port 3000)
                                        | keeps latest + history (memory + data/readings.jsonl)
                                        | pushes updates with Server-Sent Events
Browser (laptop / phone, same Wi-Fi) <-- http://<laptop-ip>:3000
```

No database, no build step, no cloud account.

> **Security note for the team:** the original project slides contain a real Wi-Fi password and a ThingSpeak
> write API key. Those are **not** in this repo. Please **regenerate the ThingSpeak write key** (ThingSpeak ->
> Channel -> API Keys -> Generate New Write API Key) and change the Wi-Fi password if the slides were shared.
> Keep real values only in `firmware/agrifly_esp32/secrets.h` and `.env`, both of which are gitignored.

## Quick start (no hardware needed)

Needs [Node.js](https://nodejs.org) 20.12 or newer.

```bash
npm install
npm start            # terminal 1 - prints the dashboard and ESP32 URLs
npm run simulate     # terminal 2 - fake device, posts every 2 s
```

Open <http://localhost:3000> (landing page) or <http://localhost:3000/dashboard>.
Stop the simulator and the status pill turns "Offline" within a few seconds.

`npm run dev` restarts the server when you edit it. `npm test` runs a quick API smoke test.

Optional: copy `.env.example` to `.env` to change the token (`AGRIFLY_TOKEN`) or port.

## Run with the real ESP32

### 1. Find the laptop's IP

`npm start` prints it, for example:

```
ESP32 should POST to http://192.168.1.23:3000/api/data
Open dashboard:      http://192.168.1.23:3000/dashboard
```

(Or run `ipconfig` on Windows and look for the "IPv4 Address" of the Wi-Fi adapter.)

### 2. Configure the firmware

Copy `firmware/agrifly_esp32/secrets.example.h` to `firmware/agrifly_esp32/secrets.h` and edit it:

```cpp
#define WIFI_SSID      "YOUR_WIFI_NAME"
#define WIFI_PASSWORD  "YOUR_WIFI_PASSWORD"
#define SERVER_URL     "http://192.168.1.23:3000/api/data"   // <- the line printed by npm start
#define DEVICE_TOKEN   "change-me"                           // must match AGRIFLY_TOKEN in .env
```

### 3. Flash it (Arduino IDE)

1. **Boards Manager:** install "esp32" by Espressif Systems. Select board **ESP32 Dev Module**.
2. **Library Manager:** install
   - ArduinoJson (Benoit Blanchon, v7)
   - Adafruit BME280 Library (accept "install all" so Adafruit Unified Sensor comes too)
   - BH1750 (Christopher Laws)
   - TinyGPSPlus (Mikal Hart)
3. Open `firmware/agrifly_esp32/agrifly_esp32.ino`, pick the COM port, Upload.
4. Open Serial Monitor at **115200** baud. You should see `Wi-Fi connected` and then `POST 200 ...` every 2 s.

Wiring is listed at the top of the `.ino` file (BME280 + BH1750 on I2C 21/22, soil on GPIO 34, gas on GPIO 35,
GPS on UART2 RX 16 / TX 17 at 9600).

Soil moisture is an **estimate**: calibrate `SOIL_RAW_DRY` / `SOIL_RAW_WET` in the sketch with the probe in dry
air and in water. The gas value is the **raw ADC level** of the MQ sensor, not ppm.

ThingSpeak upload is still available: set `#define ENABLE_THINGSPEAK 1` and put a **new** write key in
`secrets.h`. It uploads every 20 s (ThingSpeak's minimum is 15 s).

## How to add a new sensor

One line in the firmware, nothing on the website. In `readAndAddSensors()`:

```cpp
addReading("co2", co2Value, "ppm");
```

The dashboard creates a card, sparkline and chart option for any new key automatically.
To try it without hardware, uncomment the `co2` line in `tools/simulate.js`.

## Troubleshooting

| Problem | Fix |
|---|---|
| ESP32 prints `POST failed: connection refused` | Server not running, or wrong IP in `SERVER_URL`. Re-check the IP printed by `npm start`. |
| Phone can't open the dashboard | Phone and laptop must be on the **same** Wi-Fi. Use the `192.168.x.x` address, not `localhost`. |
| Works on laptop, not from ESP32/phone | **Windows Firewall:** the first `npm start` shows a popup - click **Allow** (tick Private networks). If you missed it: Windows Security -> Firewall -> Allow an app -> Node.js. |
| No router in the field | Turn on a **phone hotspot**, connect both the laptop and the ESP32 to it. Note the hotspot must be 2.4 GHz for the ESP32. |
| `POST 401` | `DEVICE_TOKEN` in `secrets.h` doesn't match `AGRIFLY_TOKEN` in `.env`. |
| Map says "No GPS fix yet" | Normal indoors. Take the GPS outside with clear sky; first fix can take a few minutes. |
| A sensor's card is missing | The sketch skips sensors that fail to start (check Serial Monitor for `not found`) and retries every 10 s. Check wiring. |
| Laptop IP changed | Update `SERVER_URL` in `secrets.h` and re-flash. |

## Project layout

```
server.js                     Express server: API, SSE, JSONL storage
public/                       Landing page, dashboard, CSS, JS (Chart.js + Leaflet from CDN)
firmware/agrifly_esp32/       ESP32 sketch + secrets.example.h
tools/simulate.js             Fake device for testing
tools/smoke-test.js           npm test
docs/api.md                   API and data format
data/readings.jsonl           Saved readings (gitignored, created on first run)
```

## Planned (not built yet)

NDVI imaging, thermal imaging, AI crop analysis, autonomous flight, mobile app, yield forecasting.
