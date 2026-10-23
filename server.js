// AgriFly server. Two data sources feed one store:
//   blynk - polled from Blynk Cloud's HTTPS API, only while someone is watching
//   local - ESP32 POSTs JSON to /api/data on the same Wi-Fi
// Browsers get live updates over Server-Sent Events.
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

try { process.loadEnvFile(); } catch { /* no .env file: use defaults */ }

const PORT = Number(process.env.PORT) || 3000;
const LOCAL_TOKEN = process.env.LOCAL_TOKEN || process.env.AGRIFLY_TOKEN || 'change-me';
const BLYNK_TOKEN = (process.env.BLYNK_TOKEN || '').trim();
const BLYNK_SERVER = (process.env.BLYNK_SERVER || 'blr1.blynk.cloud').replace(/\/+$/, '');
// a bare host means https; a full http:// URL is allowed so tools/smoke-test.js can use a fake Blynk
const BLYNK_BASE = /^https?:\/\//.test(BLYNK_SERVER) ? BLYNK_SERVER : `https://${BLYNK_SERVER}`;
const BLYNK_POLL_MS = Math.max(1000, Number(process.env.BLYNK_POLL_MS) || 3000);
const SOURCES = ['blynk', 'local'];
const MAX_MEMORY = 2000; // per source
const SENSORS = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'sensors.json'), 'utf8'));
// On Vercel only /tmp is writable, and it is wiped when the instance is recycled.
// ponytail: Vercel keeps data per instance only; add a shared store (e.g. Redis) if the hosted copy must keep history
const DATA_FILE = process.env.DATA_FILE
  || (process.env.VERCEL ? path.join(os.tmpdir(), 'readings.jsonl') : path.join(__dirname, 'data', 'readings.jsonl'));

// ---------- storage: memory per source + append-only JSONL ----------
const history = { blynk: [], local: [] };
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
if (fs.existsSync(DATA_FILE)) {
  // ponytail: reads the whole file on boot; fine for a school project, rotate the file if it grows to hundreds of MB
  for (const line of fs.readFileSync(DATA_FILE, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      r.source = SOURCES.includes(r.source) ? r.source : 'local'; // records from before Blynk support were local
      history[r.source].push(r);
    } catch { /* skip a half-written line */ }
  }
  for (const s of SOURCES) history[s] = history[s].slice(-MAX_MEMORY);
}

function store(source, { device, readings, gps = null }) {
  const record = { t: Date.now(), source, device, readings, gps };
  const list = history[source];
  list.push(record);
  if (list.length > MAX_MEMORY) list.splice(0, list.length - MAX_MEMORY);
  fs.appendFile(DATA_FILE, JSON.stringify(record) + '\n', (err) => { if (err) console.error('write failed:', err.message); });
  const msg = `data: ${JSON.stringify(record)}\n\n`;
  for (const res of streams[source]) res.write(msg);
  return record;
}

// Accepts { key: number } or { key: { value, unit } }. Drops anything that isn't a finite number.
function normalizeReadings(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, raw] of Object.entries(input)) {
    if (!/^[\w.-]{1,40}$/.test(key)) continue;
    const value = typeof raw === 'object' && raw !== null ? raw.value : raw;
    const unit = typeof raw === 'object' && raw !== null && typeof raw.unit === 'string' ? raw.unit.slice(0, 16) : '';
    const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
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

// ---------- SSE clients, per source ----------
const streams = { blynk: new Set(), local: new Set() };
setInterval(() => { for (const s of SOURCES) for (const res of streams[s]) res.write(': ping\n\n'); }, 15000).unref();

// ---------- Blynk poller ----------
// Polls only while someone watches (an open blynk stream, or a /api/latest?source=blynk in the last 10 s),
// so the Blynk monthly message quota isn't spent while nobody is looking.
const blynk = { configured: Boolean(BLYNK_TOKEN), deviceOnline: null, lastUpdate: null, lastError: null, timer: null, delay: BLYNK_POLL_MS, polls: 0, lastWatch: 0 };
const BLYNK_PINS = SENSORS.filter((s) => s.blynkPin);

const watchingBlynk = () => streams.blynk.size > 0 || Date.now() - blynk.lastWatch < 10000;

function ensureBlynkPolling() {
  if (!blynk.configured || blynk.timer || !watchingBlynk() || !BLYNK_PINS.length) return;
  console.log('Blynk: polling started (someone is watching)');
  blynk.timer = setTimeout(pollBlynk, 0);
}

async function blynkGet(apiPath) {
  // the token is only ever in this URL; it is never logged or sent to browsers
  const res = await fetch(`${BLYNK_BASE}${apiPath}${apiPath.includes('?') ? '&' : '?'}token=${encodeURIComponent(BLYNK_TOKEN)}`,
    { signal: AbortSignal.timeout(5000) });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 120);
    try { detail = JSON.parse(text).error?.message || detail; } catch { /* plain text */ }
    throw new Error(`Blynk HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}: ${detail}`);
  }
  return text;
}

// One pin returns a raw value ("1"); several return {"v0":"1","v1":"23.5"}. Multi-value pins come as arrays.
function parseBlynkValues(text) {
  let data;
  try { data = JSON.parse(text); } catch { data = text.trim(); }
  if (BLYNK_PINS.length === 1 && (typeof data !== 'object' || data === null || Array.isArray(data))) {
    data = { [BLYNK_PINS[0].blynkPin]: data };
  }
  const lower = Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
  const raw = {};
  for (const s of BLYNK_PINS) {
    const v = lower[s.blynkPin.toLowerCase()];
    if (v !== undefined) raw[s.key] = { value: v, unit: s.unit || '' };
  }
  return normalizeReadings(raw);
}

async function pollBlynk() {
  blynk.timer = null;
  if (!watchingBlynk()) { console.log('Blynk: polling paused (nobody watching)'); return; }
  try {
    // isHardwareConnected every 4th poll keeps the status fresh without doubling the request count
    if (blynk.polls % 4 === 0) blynk.deviceOnline = (await blynkGet('/external/api/isHardwareConnected')).trim() === 'true';
    const pins = BLYNK_PINS.map((s) => encodeURIComponent(s.blynkPin)).join('&');
    const readings = parseBlynkValues(await blynkGet(`/external/api/get?${pins}`));
    blynk.polls++;
    if (blynk.lastError) console.log('Blynk: recovered');
    blynk.lastError = null;
    blynk.delay = BLYNK_POLL_MS;
    // an offline device still has its last values in Blynk; don't record those as fresh readings
    if (blynk.deviceOnline !== false && Object.keys(readings).length) {
      blynk.lastUpdate = store('blynk', { device: 'blynk', readings }).t;
    }
  } catch (err) {
    blynk.lastError = err.name === 'TimeoutError' ? 'Blynk did not answer within 5 s' : err.message;
    blynk.delay = Math.min(blynk.delay * 2, 60000);
    console.warn(`Blynk: ${blynk.lastError} - retrying in ${Math.round(blynk.delay / 1000)} s`);
  }
  blynk.timer = setTimeout(pollBlynk, blynk.delay);
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '16kb' }));

const sourceOf = (req) => (SOURCES.includes(req.query.source) ? req.query.source : 'blynk');

app.post('/api/data', (req, res) => {
  const body = req.body || {};
  if (body.token !== LOCAL_TOKEN) return res.status(401).json({ ok: false, error: 'bad token' });
  const readings = normalizeReadings(body.readings);
  if (!Object.keys(readings).length) return res.status(400).json({ ok: false, error: 'no numeric readings' });
  store('local', { device: String(body.device || 'unknown').slice(0, 40), readings, gps: normalizeGps(body.gps) });
  res.json({ ok: true });
});

app.get('/api/stream', (req, res) => {
  const source = sourceOf(req);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  streams[source].add(res);
  if (source === 'blynk') ensureBlynkPolling();
  req.on('close', () => streams[source].delete(res));
});

// `now` lets browsers correct for their own clock being off from the server's.
app.get('/api/latest', (req, res) => {
  const source = sourceOf(req);
  if (source === 'blynk') { blynk.lastWatch = Date.now(); ensureBlynkPolling(); }
  res.json({ now: Date.now(), source, latest: history[source].at(-1) || null });
});

app.get('/api/history', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), MAX_MEMORY);
  const source = sourceOf(req);
  res.json({ now: Date.now(), source, readings: history[source].slice(-limit) });
});

app.get('/api/status', (req, res) => res.json({
  now: Date.now(),
  blynk: {
    configured: blynk.configured,
    deviceOnline: blynk.deviceOnline,
    lastUpdate: blynk.lastUpdate,
    lastError: blynk.lastError,
    polling: Boolean(blynk.timer),
  },
  local: { lastUpdate: history.local.at(-1)?.t ?? null },
}));

app.get('/api/sensors', (req, res) => res.json(SENSORS.map(({ key, label, unit, type, onText, offText }) => ({ key, label, unit, type, onText, offText }))));

app.get('/api/export.csv', (req, res) => {
  const source = sourceOf(req);
  const list = history[source];
  const keys = [...new Set(list.flatMap((r) => Object.keys(r.readings)))];
  const units = Object.fromEntries(keys.map((k) => [k, list.findLast((r) => r.readings[k])?.readings[k].unit || '']));
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const header = ['time', 'source', 'device', 'lat', 'lon', ...keys.map((k) => (units[k] ? `${k} (${units[k]})` : k))];
  const rows = list.map((r) => [
    new Date(r.t).toISOString(), r.source, r.device, r.gps?.lat ?? '', r.gps?.lon ?? '',
    ...keys.map((k) => r.readings[k]?.value ?? ''),
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="agrifly-${source}-readings.csv"`);
  res.send('﻿' + [header, ...rows].map((row) => row.map(esc).join(',')).join('\n'));
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.use(express.static(path.join(__dirname, 'public')));

module.exports = app; // Vercel imports the app instead of running it

if (require.main === module) app.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`\nAgriFly server running on port ${PORT}`);
  for (const ip of ips.length ? ips : ['localhost']) {
    console.log(`\n  ESP32 LOCAL_URL = http://${ip}:${PORT}/api/data`);
    console.log(`  Dashboard:       http://${ip}:${PORT}/dashboard`);
  }
  console.log(`\n  On this laptop:  http://localhost:${PORT}`);
  console.log(blynk.configured
    ? `  Blynk Cloud:     token configured (${BLYNK_SERVER}), polling every ${BLYNK_POLL_MS / 1000} s while a dashboard is open`
    : '  Blynk Cloud:     NOT configured - add BLYNK_TOKEN to .env to read data from Blynk');
  if (LOCAL_TOKEN === 'change-me') console.log('  Local token:     default "change-me" (set LOCAL_TOKEN in .env to change it)');
  console.log('');
});
