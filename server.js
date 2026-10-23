// AgriFly server: ESP32 POSTs readings, browsers get them live over SSE.
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

try { process.loadEnvFile(); } catch { /* no .env file: use defaults */ }

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = process.env.AGRIFLY_TOKEN || 'change-me';
const MAX_MEMORY = 2000;
// On Vercel only /tmp is writable, and it is wiped when the instance is recycled.
// ponytail: Vercel keeps data per instance only; add a shared store (e.g. Redis) if the hosted copy must keep history
const DATA_FILE = process.env.DATA_FILE
  || (process.env.VERCEL ? path.join(os.tmpdir(), 'readings.jsonl') : path.join(__dirname, 'data', 'readings.jsonl'));

// ---------- storage: memory ring + append-only JSONL ----------
let history = [];
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
if (fs.existsSync(DATA_FILE)) {
  // ponytail: reads the whole file on boot; fine for a school project, rotate the file if it grows to hundreds of MB
  const lines = fs.readFileSync(DATA_FILE, 'utf8').split('\n').filter(Boolean).slice(-MAX_MEMORY);
  for (const line of lines) {
    try { history.push(JSON.parse(line)); } catch { /* skip a half-written line */ }
  }
}

// Accepts { key: number } or { key: { value, unit } }. Drops anything that isn't a finite number.
function normalizeReadings(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, raw] of Object.entries(input)) {
    if (!/^[\w.-]{1,40}$/.test(key)) continue;
    const value = typeof raw === 'object' && raw !== null ? raw.value : raw;
    const unit = typeof raw === 'object' && raw !== null && typeof raw.unit === 'string' ? raw.unit.slice(0, 16) : '';
    const num = typeof value === 'string' ? Number(value) : value;
    if (typeof num === 'number' && Number.isFinite(num)) out[key] = { value: num, unit };
  }
  return out;
}

function normalizeGps(gps) {
  if (!gps || gps.valid === false) return null;
  const lat = Number(gps.lat), lon = Number(gps.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

// ---------- SSE clients ----------
const clients = new Set();
function broadcast(record) {
  const msg = `data: ${JSON.stringify(record)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000).unref();

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '16kb' }));

app.post('/api/data', (req, res) => {
  const body = req.body || {};
  if (body.token !== TOKEN) return res.status(401).json({ ok: false, error: 'bad token' });
  const readings = normalizeReadings(body.readings);
  if (!Object.keys(readings).length) return res.status(400).json({ ok: false, error: 'no numeric readings' });

  const record = {
    t: Date.now(),
    device: String(body.device || 'unknown').slice(0, 40),
    readings,
    gps: normalizeGps(body.gps),
  };
  history.push(record);
  if (history.length > MAX_MEMORY) history = history.slice(-MAX_MEMORY);
  res.json({ ok: true });

  fs.appendFile(DATA_FILE, JSON.stringify(record) + '\n', (err) => { if (err) console.error('write failed:', err.message); });
  broadcast(record);
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// `now` lets browsers correct for their own clock being off from the laptop's.
app.get('/api/latest', (req, res) => res.json({ now: Date.now(), latest: history.at(-1) || null }));

app.get('/api/history', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), MAX_MEMORY);
  res.json({ now: Date.now(), readings: history.slice(-limit) });
});

app.get('/api/export.csv', (req, res) => {
  const keys = [...new Set(history.flatMap((r) => Object.keys(r.readings)))];
  const units = Object.fromEntries(keys.map((k) => [k, history.findLast((r) => r.readings[k])?.readings[k].unit || '']));
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const header = ['time', 'device', 'lat', 'lon', ...keys.map((k) => (units[k] ? `${k} (${units[k]})` : k))];
  const rows = history.map((r) => [
    new Date(r.t).toISOString(), r.device, r.gps?.lat ?? '', r.gps?.lon ?? '',
    ...keys.map((k) => r.readings[k]?.value ?? ''),
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="agrifly-readings.csv"');
  res.send('﻿' + [header, ...rows].map((row) => row.map(esc).join(',')).join('\n'));
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.use(express.static(path.join(__dirname, 'public')));

module.exports = app; // Vercel imports the app instead of running it

if (require.main === module) app.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`\nAgriFly server running on port ${PORT}`);
  if (TOKEN === 'change-me') console.log('(using default token "change-me" - set AGRIFLY_TOKEN in .env)');
  for (const ip of ips.length ? ips : ['localhost']) {
    console.log(`\n  ESP32 should POST to http://${ip}:${PORT}/api/data`);
    console.log(`  Open dashboard:      http://${ip}:${PORT}/dashboard`);
  }
  console.log(`\n  On this laptop:      http://localhost:${PORT}\n`);
});
