// AgriFly server. Runs two ways from the same code:
//   Local (npm start): two sources feed one store, each polled ONLY while a dashboard watches it, live over SSE.
//     blynk - read from Blynk Cloud's HTTPS API (while a source=blynk stream is open)
//     local - read from the ESP32's own web server, GET http://<esp>/data (while a source=local stream is open)
//   Vercel (process.env.VERCEL): Blynk only. No listen, no pollers, no files, no SSE; browsers poll /api/latest,
//     which reads Blynk on demand behind a short cache (one poll interval) (in this module and on Vercel's CDN).
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BLYNK_PINS, publicSensors, normalizeReadings, normalizeGps } = require('./lib/sensors');
const { createBlynk } = require('./lib/blynk');

try { process.loadEnvFile(); } catch { /* no .env file: use defaults */ }

const IS_VERCEL = Boolean(process.env.VERCEL);
const PORT = Number(process.env.PORT) || 3000;
const BLYNK_POLL_MS = Math.max(1000, Number(process.env.BLYNK_POLL_MS) || 2000);
const ESP_HOST = (process.env.ESP_HOST || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const LOCAL_POLL_MS = Math.max(500, Number(process.env.LOCAL_POLL_MS) || 1000);
const ESP_IP_PIN = 'v10';          // the ESP32 writes its local IP here on every Blynk connect
const MDNS_HOST = 'agrifly.local';
const SOURCES = ['blynk', 'local'];
const MAX_MEMORY = 2000; // per source
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'readings.jsonl');
const LOCAL_ONLY = 'Available only when running on the same network (npm start).';

const blynkApi = createBlynk({ token: process.env.BLYNK_TOKEN, server: process.env.BLYNK_SERVER, ttl: BLYNK_POLL_MS });
const CACHE_S = Math.max(1, Math.round(BLYNK_POLL_MS / 1000)); // Vercel CDN cache, same length as one poll

// ---------- storage (local only): memory per source + append-only JSONL ----------
const history = { blynk: [], local: [] };
if (!IS_VERCEL) {
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

// ---------- SSE clients, per source (local only) ----------
const streams = { blynk: new Set(), local: new Set() };
if (!IS_VERCEL) setInterval(() => { for (const s of SOURCES) for (const res of streams[s]) res.write(': ping\n\n'); }, 15000).unref();

// ---------- Blynk poller (local only) ----------
const blynk = { configured: blynkApi.configured, deviceOnline: null, lastUpdate: null, lastError: null, timer: null, delay: BLYNK_POLL_MS, polls: 0 };

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
    if (blynk.polls % 4 === 0) blynk.deviceOnline = await blynkApi.isOnline();
    const readings = await blynkApi.readValues();
    blynk.polls++;
    if (blynk.lastError) console.log('Blynk: recovered');
    blynk.lastError = null;
    blynk.delay = BLYNK_POLL_MS;
    // an offline device still has its last values in Blynk; don't record those as fresh readings
    if (blynk.deviceOnline !== false && Object.keys(readings).length) {
      blynk.lastUpdate = store('blynk', { device: 'blynk', readings }).t;
    }
  } catch (err) {
    blynk.lastError = blynkError(err);
    blynk.delay = Math.min(blynk.delay * 2, 60000);
    console.warn(`Blynk: ${blynk.lastError} - retrying in ${Math.round(blynk.delay / 1000)} s`);
  }
  blynk.timer = setTimeout(pollBlynk, blynk.delay);
}

const blynkError = (err) => (err.name === 'TimeoutError' ? 'Blynk did not answer within 5 s' : err.message);

// ---------- Local: pull from the ESP32's own web server (local only) ----------
const local = { host: null, hostSource: null, reachable: null, lastUpdate: null, lastError: null, timer: null, fails: 0 };

// ESP_HOST in .env wins; otherwise the IP the ESP32 published on Blynk V10; otherwise mDNS.
async function resolveEspHost() {
  if (ESP_HOST) return { host: ESP_HOST, hostSource: 'env' };
  if (blynk.configured) {
    try {
      const text = (await blynkApi.get(`/external/api/get?${ESP_IP_PIN}`)).trim();
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

// tells the browser which way this copy runs: SSE + both sources locally, polling + Blynk only on Vercel
app.get('/api/config', (req, res) => res.json({
  deployment: IS_VERCEL ? 'vercel' : 'local',
  localModeAvailable: !IS_VERCEL,
  pollMs: BLYNK_POLL_MS,
}));

if (IS_VERCEL) {
  // Read Blynk on demand. The CDN serves this response to everyone for one poll interval (2 s by default),
  // and the module caches for the same time, so ten open tabs cost the same Blynk quota as one.
  app.get('/api/latest', async (req, res) => {
    if (sourceOf(req) !== 'blynk') return res.status(400).json({ error: `Local Wi-Fi is not available here. ${LOCAL_ONLY}` });
    if (!blynkApi.configured) {
      return res.status(503).json({ configured: false, error: 'BLYNK_TOKEN is not set on the server. Add it in Vercel: Settings > Environment Variables, then redeploy.' });
    }
    try {
      const snap = await blynkApi.snapshot();
      const fresh = snap.deviceOnline !== false && Object.keys(snap.readings).length > 0;
      res.set('Cache-Control', `public, s-maxage=${CACHE_S}, stale-while-revalidate=${CACHE_S}`);
      res.json({
        now: Date.now(), source: 'blynk', configured: true,
        deviceOnline: snap.deviceOnline, timestamp: snap.t, readings: snap.readings,
        // same shape as the local server; null while the device is offline (Blynk keeps its old values)
        latest: fresh ? { t: snap.t, source: 'blynk', device: 'blynk', readings: snap.readings, gps: null } : null,
      });
    } catch (err) {
      res.status(502).json({ configured: true, error: blynkError(err) });
    }
  });
  // no long-lived connections or server-side history on serverless
  app.get('/api/stream', (req, res) => res.status(404).json({ error: 'Live streams run only with npm start. On Vercel, poll /api/latest.' }));
}

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
  const latest = history[source].at(-1) || null;
  res.json({
    now: Date.now(), source, latest,
    deviceOnline: source === 'blynk' ? blynk.deviceOnline : local.reachable,
    timestamp: latest?.t ?? null,
    readings: latest?.readings ?? {},
  });
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

app.get('/api/sensors', (req, res) => res.json(publicSensors()));

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

if (require.main === module && !IS_VERCEL) app.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`\nAgriFly server running on port ${PORT}`);
  for (const ip of ips.length ? ips : ['localhost']) console.log(`  Dashboard:      http://${ip}:${PORT}/dashboard`);
  console.log(`  On this laptop: http://localhost:${PORT}`);
  console.log(blynk.configured
    ? `  Blynk Cloud:    token configured (${blynkApi.server}), polled every ${BLYNK_POLL_MS / 1000} s while a dashboard shows Blynk`
    : '  Blynk Cloud:    NOT configured - add BLYNK_TOKEN to .env to read data from Blynk');
  console.log(`  Local Wi-Fi:    ESP32 address from ${ESP_HOST ? `ESP_HOST (${ESP_HOST})` : blynk.configured ? `Blynk ${ESP_IP_PIN.toUpperCase()}, else ${MDNS_HOST}` : MDNS_HOST}, polled every ${LOCAL_POLL_MS / 1000} s while a dashboard shows Local Wi-Fi`);
  console.log('');
});
