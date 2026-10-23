// Fake AgriFly device for the Local Wi-Fi source.
//   npm run simulate              IR sensor only (toggles at random, like a hand passing)
//   npm run simulate -- --all     also temperature, humidity, soil, light and a GPS point walking near Chennai
//   SERVER=http://192.168.1.20:3000 npm run simulate
try { process.loadEnvFile(); } catch { /* no .env */ }

const SERVER = process.env.SERVER || 'http://localhost:3000';
const TOKEN = process.env.LOCAL_TOKEN || process.env.AGRIFLY_TOKEN || 'change-me';
const ALL = process.argv.includes('--all');
const INTERVAL_MS = 2000;

// --all sensors, one line each: [start, min, max, step per tick, unit]. Add a line and a new card appears.
const EXTRA = {
  temperature: [31, 24, 38, 0.15, '°C'],
  humidity: [62, 35, 90, 0.6, '%'],
  soil: [41, 10, 80, 0.8, '% est.'],
  light: [5400, 500, 60000, 400, 'lux'],
};

const state = Object.fromEntries(Object.entries(EXTRA).map(([k, [start]]) => [k, start]));
const CENTER = { lat: 13.0827, lon: 80.2707 };
let ir = 0, step = 0;

function drift(key) {
  const [, min, max, size] = EXTRA[key];
  state[key] = Math.min(max, Math.max(min, state[key] + (Math.random() * 2 - 1) * size));
  return Math.round(state[key] * 10) / 10;
}

async function send() {
  if (Math.random() < 0.3) ir = ir ? 0 : 1; // toggles now and then
  const readings = { ir };
  const body = { device: 'agrifly-sim', token: TOKEN, readings };
  if (ALL) {
    for (const [key, cfg] of Object.entries(EXTRA)) readings[key] = { value: drift(key), unit: cfg[4] };
    const a = (step++ / 90) * 2 * Math.PI; // ~60 m loop, one lap every 3 minutes
    body.gps = {
      lat: +(CENTER.lat + 0.0005 * Math.sin(a)).toFixed(6),
      lon: +(CENTER.lon + 0.0006 * Math.cos(a) * (1 + 0.3 * Math.sin(3 * a))).toFixed(6),
      valid: true,
    };
  }

  try {
    const res = await fetch(`${SERVER}/api/data`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const summary = Object.entries(readings).map(([k, v]) => `${k}=${typeof v === 'object' ? v.value : v}`).join(' ');
    console.log(`${new Date().toLocaleTimeString()}  HTTP ${res.status}  ${summary}`);
  } catch (err) {
    console.log(`${new Date().toLocaleTimeString()}  server not reachable at ${SERVER} (${err.cause?.code || err.message})`);
  }
}

console.log(`Simulating ${ALL ? 'IR + temperature, humidity, soil, light, GPS' : 'IR sensor'} -> ${SERVER}/api/data every ${INTERVAL_MS / 1000}s (Ctrl+C to stop)`);
send();
setInterval(send, INTERVAL_MS);
