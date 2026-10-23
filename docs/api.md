# AgriFly server API

All endpoints are served by `server.js` on port 3000 (bound to `0.0.0.0`).

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/data` | Device sends one set of readings. Returns `200 {"ok":true}`. `401` on bad token, `400` if no numeric readings. |
| GET | `/api/stream` | Server-Sent Events. Each new reading arrives as `data: {...}`. Heartbeat comment every 15 s. |
| GET | `/api/latest` | `{ now, latest }` - the newest reading (or `null`). |
| GET | `/api/history?limit=500` | `{ now, readings: [...] }` - oldest first, up to 2000. |
| GET | `/api/export.csv` | All readings in memory as CSV (one column per reading key). |

`now` is the server's clock, so browsers with a wrong clock still show correct "X s ago" times.

## POST body

```json
{
  "device": "agrifly-01",
  "token": "change-me",
  "readings": {
    "temperature": { "value": 31.4, "unit": "°C" },
    "humidity": 62,
    "soil": { "value": 41, "unit": "% est." }
  },
  "gps": { "lat": 13.0827, "lon": 80.2707, "valid": true }
}
```

- `readings` can hold any keys (letters, digits, `_ . -`, max 40 chars). Each value is a number or `{ value, unit }`. Non-numeric values are dropped.
- `gps` is optional. It is ignored when `valid` is `false`, missing, out of range, or exactly `0,0`.
- The server adds the timestamp `t` (ms since epoch) when the reading arrives.

## Stored record

```json
{ "t": 1761240000000, "device": "agrifly-01", "readings": { "temperature": { "value": 31.4, "unit": "°C" } }, "gps": { "lat": 13.0827, "lon": 80.2707 } }
```

The last 2000 records are kept in memory. Every record is also appended to `data/readings.jsonl`, which is reloaded on restart.

## Quick manual test

```bash
curl -X POST http://localhost:3000/api/data -H "Content-Type: application/json" \
  -d '{"device":"test","token":"change-me","readings":{"temperature":30.5}}'
```
