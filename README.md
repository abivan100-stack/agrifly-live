# AgriFly

**Smarter Technology for Smarter Farming** - Team 5 (Rokith Kumaar, Deepak Kumar, Adhithya), 2026-27.

AgriFly is an IoT field-monitoring system. An FPV drone carries an ESP32 with sensors and sends readings to a
live dashboard. Right now we are testing with **one IR obstacle sensor** (1 = object detected, 0 = clear).
Planned next: BME280 (temperature, humidity, pressure), BH1750 (light), soil moisture (estimated %),
MQ gas sensor (raw level) and NEO-6M GPS.

The dashboard can read the ESP32 two ways:

```
ESP32 ── writes V0 (IR) and V10 (its IP) ──► Blynk Cloud ◄── HTTPS, while a dashboard shows "Blynk Cloud" ──┐
  │                                                                                                         │
  └── serves GET http://<esp-ip>/data ◄──────────── HTTP, while a dashboard shows "Local Wi-Fi" ──── Node server (port 3000)
                                                                                                            │ Server-Sent Events
                                                         Browser: dashboard with [Blynk Cloud | Local Wi-Fi] toggle
```

The server only polls a source while a dashboard is showing it. No dashboard open = no polling at all.
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

Open the dashboard on this laptop (<http://localhost:3000/dashboard>) or on any phone on the same Wi-Fi using
the `Dashboard:` address that `npm start` prints.

### Test Local mode without hardware

```bash
npm run simulate -- --all     # fake ESP32 at http://localhost:8080/data (IR + temperature, humidity, soil, light, GPS)
```

Put `ESP_HOST=localhost:8080` in `.env`, restart `npm start`, and choose **Local Wi-Fi** on the dashboard.
New sensor cards appear by themselves. `npm run simulate` without `--all` serves the IR sensor only.
`npm test` runs a self-check against a fake Blynk server and a fake ESP32.

## Blynk setup

In the Blynk console, the template needs two datastreams:

| Virtual pin | Name | Type | Used for |
|---|---|---|---|
| V0 | IR | Integer, 0-1 | the IR sensor reading |
| V10 | ESP IP | String | the ESP32's local IP, written on every connect, so Local mode can find it |

## Dashboard sources

The toggle at the top switches between:

- **Blynk Cloud** (default): works from any network. The server reads Blynk every 3 s (`BLYNK_POLL_MS`) while a
  dashboard shows Blynk. Status comes from Blynk's "is the device connected" check.
- **Local Wi-Fi**: the server asks the ESP32 directly for `GET http://<esp>/data` every 2 s (`LOCAL_POLL_MS`).
  The server and the ESP32 must be on the same network. The dashboard shows which address it uses and where it
  came from.

Switching closes the old stream, so the other source stops being polled. The dashboard remembers your choice.
**Download CSV** exports the selected source.

### How Local mode finds the ESP32

No IP needs typing anywhere. The server tries, in order:

1. `ESP_HOST` in `.env`, if you set it (manual override, e.g. `192.168.1.25`)
2. Blynk pin **V10**, where the ESP32 publishes its IP each time it connects to Blynk. Read when Local mode starts,
   and again after 3 failed requests in a row (in case the ESP32 got a new IP).
3. `agrifly.local` (mDNS)

## Flash the ESP32 (Arduino IDE)

1. **Boards Manager:** install "esp32" by Espressif Systems. Select board **ESP32 Dev Module**.
2. **Library Manager:** install **Blynk** (by Volodymyr Shymanskyy).
3. Copy `firmware/agrifly_esp32/secrets.example.h` to `secrets.h` in the same folder and fill in
   `BLYNK_TEMPLATE_ID`, `BLYNK_TEMPLATE_NAME`, `BLYNK_AUTH_TOKEN` (Blynk console) and `WIFI_SSID`,
   `WIFI_PASSWORD` (a 2.4 GHz network).
4. Check `IR_PIN` in `agrifly_esp32.ino` matches your wiring (default GPIO 27).
5. Upload, then open Serial Monitor at 115200 baud. You should see
   `Wi-Fi connected. Local data: http://192.168.x.x/data`. Wave your hand: `IR: object detected`.

## How to add a sensor

Three small steps, no website code:

1. **Blynk console:** add a datastream, e.g. Virtual Pin `V1`, type Double.
2. **Firmware:** read the sensor, then one line in `sendBlynk()` and one in `handleData()`:
   ```cpp
   Blynk.virtualWrite(V1, temperature);
   addReading(json, "temperature", temperature, "°C");
   ```
3. **`config/sensors.json`:** add one entry and restart the server:
   ```json
   { "key": "temperature", "blynkPin": "v1", "label": "Temperature", "unit": "°C", "type": "number" }
   ```
   `type` is `"binary"` (on/off with `onText`/`offText`, step chart) or `"number"` (value + unit, line chart).

Any other key the ESP32 returns from `/data` also gets a card automatically in Local mode.

## Troubleshooting

| Problem | Fix |
|---|---|
| Dashboard says "Blynk not set up" | `BLYNK_TOKEN` is empty in `.env`. Paste the token and restart `npm start`. |
| "Blynk error: ... Invalid token" | Wrong token, or `BLYNK_SERVER` is not your region (e.g. `blr1.blynk.cloud`). |
| "Blynk error: ... rate limited" | Blynk's message quota or rate limit was hit. The server backs off automatically; raise `BLYNK_POLL_MS` (e.g. 5000) and close dashboards you aren't using. |
| Blynk shows "Device offline" | The ESP32 isn't connected to Blynk. Check Serial Monitor, the auth token in `secrets.h`, and that the Wi-Fi is **2.4 GHz** (the ESP32 can't use 5 GHz). |
| Local: "ESP32 not reachable on this network" | The laptop and the ESP32 must be on the **same** Wi-Fi. A phone hotspot works as the shared network (2.4 GHz). Guest networks often block devices from seeing each other. |
| Local: address shows `agrifly.local` and it doesn't resolve | V10 isn't set (check the V10 datastream exists and the ESP32 reached Blynk). Set `ESP_HOST` in `.env` to the IP shown in Serial Monitor (`Local data: http://<ip>/data`) and restart. |
| Local: the IP keeps changing | Give the ESP32 a fixed IP (DHCP reservation) in your router, or rely on V10, which the server re-reads after 3 failures. |
| Phone can't open the dashboard | Use the `Dashboard:` address from `npm start`, not `localhost`. **Windows Firewall:** the first `npm start` shows a popup - click **Allow** (tick Private networks). |

## Project layout

```
server.js                     Express server: Blynk + ESP32 pollers (on demand), SSE, JSONL storage
config/sensors.json           Sensor list: key, Blynk pin, label, unit, binary/number
public/                       Landing page and dashboard (plain HTML/CSS/JS, Chart.js + Leaflet from CDN)
firmware/agrifly_esp32/       ESP32 sketch + secrets.example.h
tools/simulate.js             Fake ESP32 at http://localhost:8080/data (npm run simulate [-- --all])
tools/smoke-test.js           npm test
docs/api.md                   API and data formats
data/readings.jsonl           Saved readings (gitignored, created on first run)
```

## Planned (not built yet)

NDVI imaging, thermal imaging, AI crop analysis, autonomous flight, mobile app, yield forecasting.
