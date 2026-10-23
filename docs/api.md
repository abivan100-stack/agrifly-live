# AgriFly server API

All endpoints are served by `server.js` on port 3000 (bound to `0.0.0.0`).
`source` is `blynk` (default) or `local`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/data` | Local Wi-Fi: the ESP32 sends one set of readings. `200 {"ok":true}`, `401` bad token, `400` no numeric readings. |
| GET | `/api/stream?source=` | Server-Sent Events, one message per new reading. Heartbeat comment every 15 s. Opening a `blynk` stream starts Blynk polling. |
| GET | `/api/latest?source=` | `{ now, source, latest }` |
| GET | `/api/history?source=&limit=500` | `{ now, source, readings: [...] }`, oldest first, up to 2000 per source. |
| GET | `/api/export.csv?source=` | Readings of that source as CSV, one column per reading key. |
| GET | `/api/status` | `{ now, blynk: { configured, deviceOnline, lastUpdate, lastError, polling }, local: { lastUpdate } }` |
| GET | `/api/sensors` | The sensor list from `config/sensors.json` (without Blynk pins). |

`now` is the server's clock, so browsers with a wrong clock still show correct "X s ago" times.
The Blynk token is only used server-side; no endpoint returns it.

## Blynk polling

While at least one browser has a `blynk` stream open (or asked `/api/latest?source=blynk` in the last 10 s),
the server calls, every `BLYNK_POLL_MS`:

- `GET https://{BLYNK_SERVER}/external/api/get?v0[&v1...]&token=...` - one pin returns a raw value (`1`),
  several return `{"v0":"1","v1":"23.5"}`. Pins map to sensor keys through `blynkPin` in `config/sensors.json`.
- `GET https://{BLYNK_SERVER}/external/api/isHardwareConnected?token=...` - every 4th poll, for the online status.

On an error or rate limit it logs a warning and backs off (doubling, up to 60 s). When nobody watches, it stops.

## POST body (Local Wi-Fi)

```json
{
  "device": "agrifly-01",
  "token": "change-me",
  "readings": { "ir": { "value": 1, "unit": "" }, "temperature": 31.4 },
  "gps": { "lat": 13.0827, "lon": 80.2707, "valid": true }
}
```

- Each reading is a number or `{ value, unit }`. Keys: letters, digits, `_ . -`, max 40 chars.
- `gps` is optional and ignored when `valid` is `false`, out of range, or exactly `0,0`.

## Stored record

```json
{ "t": 1761240000000, "source": "local", "device": "agrifly-01", "readings": { "ir": { "value": 1, "unit": "" } }, "gps": null }
```

Kept in memory (last 2000 per source) and appended to `data/readings.jsonl`, which is reloaded on restart.
