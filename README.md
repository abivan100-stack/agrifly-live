# AgriFly

**Smarter Technology for Smarter Farming** - Team 5 (Rokith Kumaar, Deepak Kumar, Adhithya), 2026-27.

AgriFly is an IoT field-monitoring system. An FPV drone carries an ESP32 with sensors and sends readings to a
live dashboard. Right now we are testing with **one IR obstacle sensor** (1 = object detected, 0 = clear).
Planned next: BME280 (temperature, humidity, pressure), BH1750 (light), soil moisture (estimated %),
MQ gas sensor (raw level) and NEO-6M GPS.

The ESP32 sends data two ways at the same time:

```
                    Blynk virtual pins                    HTTPS API (polled only while someone watches)
ESP32 ──────────────────────────────────► Blynk Cloud ◄───────────────────────────┐
  │                                                                                │
  │  Local Wi-Fi: HTTP POST JSON every 2 s (same network only)                  Node server (port 3000)
  └───────────────────────────────────────────────────────────────────────────►   one store, two sources
                                                                                   │ Server-Sent Events
                                          Browser: dashboard with [Blynk Cloud | Local Wi-Fi] toggle
```

No database, no build step. The Blynk token stays on the server; the browser never sees it.

> **Security note for the team:** the original project slides contain a real Wi-Fi password and a ThingSpeak
> write API key. Those are **not** in this repo. Please regenerate the ThingSpeak key and change the Wi-Fi
> password if the slides were shared. Keep real values only in `.env` and `firmware/agrifly_esp32/secrets.h`,
> both gitignored.

## Quick start

Needs [Node.js](https://nodejs.org) 20.12 or newer.

```bash
npm install
cp .env.example .env     # Windows: copy .env.example .env
```

Open `.env` and paste your Blynk device **Auth Token** after `BLYNK_TOKEN=` (Blynk console -> your device ->
Device Info). Do this yourself; don't paste the token into chats or commit it.

```bash
npm start
```

The server prints what you need:

```
  ESP32 LOCAL_URL = http://192.168.1.23:3000/api/data
  Dashboard:       http://192.168.1.23:3000/dashboard
  Blynk Cloud:     token configured (blr1.blynk.cloud), polling every 3 s while a dashboard is open
```

Open the dashboard on this laptop (<http://localhost:3000/dashboard>) or on any phone on the same Wi-Fi.

No hardware? `npm run simulate` sends fake IR data to the Local Wi-Fi source, and `npm run simulate -- --all`
adds temperature, humidity, soil, light and a moving GPS point, so you can watch new cards appear by themselves.
`npm test` runs a quick self-check against a fake Blynk server.

## Dashboard sources

The toggle at the top switches between:

- **Blynk Cloud** (default): works from any network. The server reads the ESP32's Blynk virtual pins every
  3 s (`BLYNK_POLL_MS`), but **only while a dashboard is open**, to save your Blynk monthly message quota.
  The status comes from Blynk's "is the device connected" check.
- **Local Wi-Fi**: the ESP32 posts directly to the laptop. Needs the ESP32 and laptop on the same network.
  Shows "Device offline" after 10 s without data.

The dashboard remembers your choice. **Download CSV** exports the selected source.

## Flash the ESP32 (Arduino IDE)

1. **Boards Manager:** install "esp32" by Espressif Systems. Select board **ESP32 Dev Module**.
2. **Library Manager:** install **Blynk** (by Volodymyr Shymanskyy).
3. Copy `firmware/agrifly_esp32/secrets.example.h` to `secrets.h` in the same folder and fill in:
   - `BLYNK_TEMPLATE_ID`, `BLYNK_TEMPLATE_NAME`, `BLYNK_AUTH_TOKEN` from the Blynk console
   - `WIFI_SSID`, `WIFI_PASSWORD` (2.4 GHz network)
   - `LOCAL_URL`: copy the `ESP32 LOCAL_URL = ...` line printed by `npm start` (or `""` for Blynk only)
   - `LOCAL_TOKEN`: same as `LOCAL_TOKEN` in `.env` (default `change-me`)
4. Check `IR_PIN` in `agrifly_esp32.ino` matches your wiring (default GPIO 27).
5. Upload, then open Serial Monitor at 115200 baud. Wave your hand: you should see `IR: object detected`.

## How to add a sensor

Three small steps, no website code:

1. **Blynk console:** add a datastream, e.g. Virtual Pin `V1`, type Double.
2. **Firmware** (`sendBlynk()` and `postLocal()`): read the sensor, then one line per destination:
   ```cpp
   Blynk.virtualWrite(V1, temperature);
   addLocal(json, "temperature", temperature, "°C");
   ```
3. **`config/sensors.json`:** add one entry and restart the server:
   ```json
   { "key": "temperature", "blynkPin": "v1", "label": "Temperature", "unit": "°C", "type": "number" }
   ```
   `type` is `"binary"` (on/off with `onText`/`offText`, step chart) or `"number"` (value + unit, line chart).

Any other key the ESP32 posts in Local Wi-Fi mode also gets a card automatically.

## Troubleshooting

| Problem | Fix |
|---|---|
| Dashboard says "Blynk not set up" | `BLYNK_TOKEN` is empty in `.env`. Paste the token and restart `npm start`. |
| "Blynk error: ... Invalid token" | Wrong token, or `BLYNK_SERVER` is not your region (e.g. `blr1.blynk.cloud`). |
| "Blynk error: ... rate limited" | Blynk's message quota or rate limit was hit. The server backs off automatically; raise `BLYNK_POLL_MS` (e.g. 5000) and close dashboards you aren't using. |
| Blynk shows "Device offline" | The ESP32 isn't connected to Blynk. Check Serial Monitor, the auth token in `secrets.h`, and that the Wi-Fi is **2.4 GHz** (ESP32 can't use 5 GHz). |
| Local Wi-Fi: `Local POST -1 connection refused` | Server not running, or wrong IP in `LOCAL_URL`. Re-copy it from the `npm start` output. |
| Local Wi-Fi: works on the laptop, not from the ESP32/phone | **Windows Firewall:** the first `npm start` shows a popup - click **Allow** (tick Private networks). Missed it? Windows Security -> Firewall -> Allow an app -> Node.js. |
| Local Wi-Fi: no data at all | ESP32 and laptop must be on the **same** network. A phone hotspot works as the shared network (2.4 GHz). |
| `Local POST 401` | `LOCAL_TOKEN` in `secrets.h` doesn't match `LOCAL_TOKEN` in `.env`. |
| Laptop IP changed | Update `LOCAL_URL` in `secrets.h` and re-flash. |

## Project layout

```
server.js                     Express server: Blynk poller, local POST, SSE, JSONL storage
config/sensors.json           Sensor list: key, Blynk pin, label, unit, binary/number
public/                       Landing page and dashboard (plain HTML/CSS/JS, Chart.js + Leaflet from CDN)
firmware/agrifly_esp32/       ESP32 sketch + secrets.example.h
tools/simulate.js             Fake Local Wi-Fi device (npm run simulate [-- --all])
tools/smoke-test.js           npm test
docs/api.md                   API and data formats
data/readings.jsonl           Saved readings (gitignored, created on first run)
```

## Planned (not built yet)

NDVI imaging, thermal imaging, AI crop analysis, autonomous flight, mobile app, yield forecasting.
