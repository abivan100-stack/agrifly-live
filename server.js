// AgriFly server. Two data sources feed one store, and each is polled ONLY while a dashboard watches it:
//   blynk - read from Blynk Cloud's HTTPS API (while a source=blynk stream is open)
//   local - read from the ESP32's own web server, GET http://<esp>/data (while a source=local stream is open)
// Browsers get live updates over Server-Sent Events. No dashboard open = no polling at all.
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

try { process.loadEnvFile(); } catch { /* no .env file: use defaults */ }

const PORT = Number(process.env.PORT) || 3000;
const BLYNK_TOKEN = (process.env.BLYNK_TOKEN || '').trim();
const BLYNK_SERVER = (process.env.BLYNK_SERVER || 'blr1.blynk.cloud').replace(/\/+$/, '');
// a bare host means https; a full http:// URL is allowed so tools/smoke-test.js can use a fake Blynk
const BLYNK_BASE = /^https?:\/\//.test(BLYNK_SERVER) ? BLYNK_SERVER : `https://${BLYNK_SERVER}`;
const BLYNK_POLL_MS = Math.max(1000, Number(process.env.BLYNK_POLL_MS) || 3000);
const ESP_HOST = (process.env.ESP_HOST || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const LOCAL_POLL_MS = Math.max(500, Number(process.env.LOCAL_POLL_MS) || 2000);
const ESP_IP_PIN = 'v10';          // the ESP32 writes its local IP here on every Blynk connect
const MDNS_HOST = 'agrifly.local';
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
      r.source = SOURCES.includes(r.source) ? r.source : 'local';
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

// ---------- Blynk ----------
const blynk = { configured: Boolean(BLYNK_TOKEN), deviceOnline: null, lastUpdate: null, lastError: null, timer: null, delay: BLYNK_POLL_MS, polls: 0 };
const BLYNK_PINS = SENSORS.filter((s) => s.blynkPin);

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

function startBlynk() {
  if (!blynk.configured || blynk.timer || !streams.blynk.size || !BLYNK_PINS.length) return;
  console.log('Blynk: polling started (dashboard open)');
  blynk.delay = BLYNK_POLL_MS;
  blynk.timer = setTimeout(pollBlynk, 0);
}

async function pollBlynk() {
  blynk.timer = null;
  if (!streams.blynk.size) { console.log('Blynk: polling stopped (no dashboard on Blynk)'); return; }
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

// ---------- Local: pull from the ESP32's own web server ----------
const local = { host: null, hostSource: null, reachable: null, lastUpdate: null, lastError: null, timer: null, fails: 0 };

// ESP_HOST in .env wins; otherwise the IP the ESP32 published on Blynk V10; otherwise mDNS.
async function resolveEspHost() {
  if (ESP_HOST) return { host: ESP_HOST, hostSource: 'env' };
  if (blynk.configured) {
    try {
      const text = (await blynkGet(`/external/api/get?${ESP_IP_PIN}`)).trim();
      let ip = text;
      try { const parsed = JSON.parse(text); ip = Array.isArray(parsed) ? parsed[0] : parsed; } catch { /* raw string */ }
      ip = String(ip ?? '').trim();
      if (/^[\w.-]+(:\d+)?$/.test(ip) && ip !== '0') return { host: ip, hostSource: 'blynk' };
      console.warn(`Local: Blynk ${ESP_IP_PIN.toUpperCase()} has no usable address ("${ip.slice(0, 40)}"), trying ${MDNS_HOST}`);
    } catch (err) {
      console.warn(`Local: could not read the ESP32 address from Blynk (${err.message}), trying ${MDNS_HOST}`);
    }
  }
  return { host: MDNS_HOST, hostSource: 'mdns' };
}

async function useHost() {
  const found = await resolveEspHost();
  if (found.host !== local.host) console.log(`Local: using ESP32 at ${found.host} (${found.hostSource})`);
  Object.assign(local, found);
}

function startLocal() {
  if (local.timer || !streams.local.size) return;
  console.log('Local: polling started (dashboard open)');
  local.fails = 0;
  local.timer = setTimeout(async () => { await useHost(); pollLocal(); }, 0);
}

async function pollLocal() {
  local.timer = null;
  if (!streams.local.size) { console.log('Local: polling stopped (no dashboard on Local Wi-Fi)'); return; }
  try {
    const res = await fetch(`http://${local.host}/data`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error(`ESP32 answered HTTP ${res.status}`);
    const body = await res.json();
    const readings = normalizeReadings(body.readings);
    if (!Object.keys(readings).length) throw new Error('ESP32 sent no readings');
    if (local.reachable === false) console.log(`Local: ESP32 at ${local.host} reachable again`);
    Object.assign(local, { reachable: true, lastError: null, fails: 0 });
    local.lastUpdate = store('local', { device: String(body.device || 'esp32').slice(0, 40), readings, gps: normalizeGps(body.gps) }).t;
  } catch (err) {
    local.reachable = false;
    local.fails++;
    local.lastError = err.name === 'TimeoutError' ? `no answer from ${local.host} within 1.5 s`
      : err.cause?.code ? `${err.cause.code} for ${local.host}` : err.message;
    if (local.fails === 1 || local.fails % 10 === 0) console.warn(`Local: ${local.lastError}`);
    // the ESP32 may have a new IP: re-read Blynk V10 after every 3 failures
    if (local.fails % 3 === 0 && local.hostSource !== 'env') await useHost();
  }
  local.timer = setTimeout(pollLocal, LOCAL_POLL_MS);
}

// ---------- app ----------
const app = express();
const sourceOf = (req) => (SOURCES.includes(req.query.source) ? req.query.source : 'blynk');

app.get('/api/stream', (req, res) => {
  const source = sourceOf(req);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  streams[source].add(res);
  if (source === 'blynk') startBlynk(); else startLocal();
  req.on('close', () => streams[source].delete(res)); // the poller sees the empty set on its next tick and stops
});

// `now` lets browsers correct for their own clock being off from the server's.
app.get('/api/latest', (req, res) => {
  const source = sourceOf(req);
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
  local: {
    host: local.host,
    hostSource: local.hostSource,
    reachable: local.reachable,
    lastUpdate: local.lastUpdate ?? history.local.at(-1)?.t ?? null,
    lastError: local.lastError,
    polling: Boolean(local.timer),
  },
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
  for (const ip of ips.length ? ips : ['localhost']) console.log(`  Dashboard:      http://${ip}:${PORT}/dashboard`);
  console.log(`  On this laptop: http://localhost:${PORT}`);
  console.log(blynk.configured
    ? `  Blynk Cloud:    token configured (${BLYNK_SERVER}), polled every ${BLYNK_POLL_MS / 1000} s while a dashboard shows Blynk`
    : '  Blynk Cloud:    NOT configured - add BLYNK_TOKEN to .env to read data from Blynk');
  console.log(`  Local Wi-Fi:    ESP32 address from ${ESP_HOST ? `ESP_HOST (${ESP_HOST})` : blynk.configured ? `Blynk ${ESP_IP_PIN.toUpperCase()}, else ${MDNS_HOST}` : MDNS_HOST}, polled every ${LOCAL_POLL_MS / 1000} s while a dashboard shows Local Wi-Fi`);
  console.log('');
});
