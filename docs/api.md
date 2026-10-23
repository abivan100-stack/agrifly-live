# AgriFly server API

All endpoints are served by `server.js` on port 3000 (bound to `0.0.0.0`).
`source` is `blynk` (default) or `local`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/stream?source=` | Server-Sent Events, one message per new reading, heartbeat every 15 s. Opening a stream starts polling that source; when the last stream of a source closes, its polling stops. |
| GET | `/api/config` | `{ deployment: "local" \| "vercel", localModeAvailable, pollMs }`. The pages read this first to pick SSE (local) or polling (Vercel). |
| GET | `/api/latest?source=` | `{ now, source, latest, deviceOnline, timestamp, readings }`. `latest` is the newest record or `null`. |
| GET | `/api/history?source=&limit=500` | `{ now, source, readings: [...] }`, oldest first, up to 2000 per source. |
| GET | `/api/export.csv?source=` | Readings of that source as CSV, one column per reading key. |
| GET | `/api/status` | `{ now, blynk: { configured, deviceOnline, lastUpdate, lastError, polling }, local: { host, hostSource, reachable, lastUpdate, lastError, polling } }` |
| GET | `/api/sensors` | The sensor list from `config/sensors.json` (without Blynk pins). |

`now` is the server's clock, so browsers with a wrong clock still show correct "X s ago" times.
The Blynk token is only used server-side; no endpoint returns it. No dashboard open = no polling at all.

## On Vercel (`process.env.VERCEL` set)

Blynk only. No `app.listen`, no background pollers, no files written, no SSE (`/api/stream` returns 404).
`/api/latest?source=blynk` reads Blynk on demand: one multi-pin `get` for every pin in `sensors.json`, plus
`isHardwareConnected` at most every 12 s. Answers are cached for 3 s in the function and on the CDN
(`Cache-Control: public, s-maxage=3, stale-while-revalidate=10`). `latest` is `null` while the device is offline.
Errors: `503 { configured: false, error }` when `BLYNK_TOKEN` is missing, `502 { error }` when Blynk fails,
`400` for `source=local`. `/api/history`, `/api/status` and `/api/export.csv` exist but hold no data there;
the dashboard keeps history in the tab and builds the CSV itself.

## Blynk source

While a `source=blynk` stream is open, every `BLYNK_POLL_MS` (default 3000):

- `GET https://{BLYNK_SERVER}/external/api/get?v0[&v1...]&token=...` - one pin returns a raw value (`1`),
  several return `{"v0":"1","v1":"23.5"}`. Pins map to sensor keys through `blynkPin` in `config/sensors.json`.
- `GET https://{BLYNK_SERVER}/external/api/isHardwareConnected?token=...` - every 4th poll, for the online status.

Errors and rate limits are logged and back off (doubling, up to 60 s).

## Local source (pulled from the ESP32)

While a `source=local` stream is open, every `LOCAL_POLL_MS` (default 2000), with a 1.5 s timeout:

`GET http://<esp>/data` →

```json
{ "device": "agrifly-01", "readings": { "ir": { "value": 1, "unit": "" } }, "uptime": 123 }
```

Readings may also be bare numbers; an optional `"gps": {"lat","lon","valid"}` is ignored when `valid` is false.

The ESP32 address is found in this order (`hostSource` in `/api/status`):

1. `env` - `ESP_HOST` in `.env`, e.g. `192.168.1.25` or `localhost:8080`
2. `blynk` - Blynk pin V10, which the ESP32 writes its IP to on every connect. Read when local polling
   starts, and again after every 3 failed requests (the IP may have changed).
3. `mdns` - `agrifly.local`

## Stored record

```json
{ "t": 1761240000000, "source": "local", "device": "agrifly-01", "readings": { "ir": { "value": 1, "unit": "" } }, "gps": null }
```

Kept in memory (last 2000 per source) and appended to `data/readings.jsonl`, which is reloaded on restart.
