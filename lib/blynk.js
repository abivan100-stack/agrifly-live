// Blynk Cloud HTTPS API. Used by the local server's poller and by the Vercel /api/latest handler.
// The token is only ever put into the request URL here; it is never logged or sent to browsers.
const { BLYNK_PINS, normalizeReadings } = require('./sensors');

const VALUES_TTL = 3000;   // one values request per 3 s per instance, however many viewers ask
const ONLINE_TTL = 12000;  // isHardwareConnected changes rarely; checking it every 4th time halves the quota used

function createBlynk({ token, server }) {
  token = (token || '').trim();
  server = (server || 'blr1.blynk.cloud').replace(/\/+$/, '');
  // a bare host means https; a full http:// URL is allowed so tools/smoke-test.js can use a fake Blynk
  const base = /^https?:\/\//.test(server) ? server : `https://${server}`;

  async function get(apiPath) {
    const res = await fetch(`${base}${apiPath}${apiPath.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 120);
      try { detail = JSON.parse(text).error?.message || detail; } catch { /* plain text */ }
      throw new Error(`Blynk HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}: ${detail}`);
    }
    return text;
  }

  const isOnline = async () => (await get('/external/api/isHardwareConnected')).trim() === 'true';

  // every pin from sensors.json in one request
  async function readValues() {
    const pins = BLYNK_PINS.map((s) => encodeURIComponent(s.blynkPin)).join('&');
    return parseValues(await get(`/external/api/get?${pins}`));
  }

  // Cached snapshot for serverless: { t, deviceOnline, readings }. Concurrent callers share one request.
  let snap = null, pending = null, online = { value: null, at: 0 };
  function snapshot() {
    if (snap && Date.now() - snap.t < VALUES_TTL) return Promise.resolve(snap);
    pending ??= (async () => {
      if (Date.now() - online.at > ONLINE_TTL) online = { value: await isOnline(), at: Date.now() };
      const readings = await readValues();
      return (snap = { t: Date.now(), deviceOnline: online.value, readings });
    })().finally(() => { pending = null; });
    return pending;
  }

  return { configured: Boolean(token), server, get, isOnline, readValues, snapshot };
}

// One pin returns a raw value ("1"); several return {"v0":"1","v1":"23.5"}. Multi-value pins come as arrays.
function parseValues(text) {
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

module.exports = { createBlynk };
