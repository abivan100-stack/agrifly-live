// Fake AgriFly device: posts drifting readings + a GPS point walking a loop near Chennai.
// Usage: npm run simulate            (posts to http://localhost:3000)
//        SERVER=http://192.168.1.20:3000 npm run simulate
try { process.loadEnvFile(); } catch { /* no .env */ }

const SERVER = process.env.SERVER || 'http://localhost:3000';
const TOKEN = process.env.AGRIFLY_TOKEN || 'change-me';
const INTERVAL_MS = 2000;

// One line per fake sensor: [start, min, max, step per tick, unit].
// Add a line here (e.g. co2) and a new card appears on the dashboard automatically.
const SENSORS = {
  temperature: [31, 24, 38, 0.15, '°C'],
  humidity: [62, 35, 90, 0.6, '%'],
  pressure: [1008, 1000, 1015, 0.1, 'hPa'],
  light: [5400, 500, 60000, 400, 'lux'],
  soil: [41, 10, 80, 0.8, '% est.'],
  gas_raw: [1820, 900, 2600, 25, 'ADC'],
  // co2: [420, 380, 900, 8, 'ppm'],   <- uncomment to watch a new card appear
};

const state = Object.fromEntries(Object.entries(SENSORS).map(([k, [start]]) => [k, start]));
const CENTER = { lat: 13.0827, lon: 80.2707 };
let step = 0;

function drift(key) {
  const [, min, max, size] = SENSORS[key];
  const v = state[key] + (Math.random() * 2 - 1) * size;
  state[key] = Math.min(max, Math.max(min, v));
  return state[key];
}

async function send() {
  const readings = {};
  for (const [key, [, , , , unit]] of Object.entries(SENSORS)) {
    readings[key] = { value: Math.round(drift(key) * 10) / 10, unit };
  }
  // ~60 m loop, one lap every 3 minutes
  const a = (step++ / 90) * 2 * Math.PI;
  const lat = CENTER.lat + 0.0005 * Math.sin(a);
  const lon = CENTER.lon + 0.0006 * Math.cos(a) * (1 + 0.3 * Math.sin(3 * a));
  const gps = { lat: +lat.toFixed(6), lon: +lon.toFixed(6), valid: true };

  try {
    const res = await fetch(`${SERVER}/api/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'agrifly-sim', token: TOKEN, readings, gps }),
    });
    const summary = Object.entries(readings).map(([k, v]) => `${k}=${v.value}`).join(' ');
    console.log(`${new Date().toLocaleTimeString()}  HTTP ${res.status}  ${summary}`);
  } catch (err) {
    console.log(`${new Date().toLocaleTimeString()}  server not reachable at ${SERVER} (${err.cause?.code || err.message})`);
  }
}

console.log(`Simulating AgriFly device -> ${SERVER}/api/data every ${INTERVAL_MS / 1000}s (Ctrl+C to stop)`);
send();
setInterval(send, INTERVAL_MS);
