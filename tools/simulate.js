// Fake ESP32 for the Local Wi-Fi source: answers GET http://localhost:8080/data like the real board.
//   npm run simulate              gas (raw ADC) and tilt (degrees), like the real board
//   npm run simulate -- --all     also temperature, humidity, soil, light and a GPS point walking near Chennai
// Then set ESP_HOST=localhost:8080 in .env, restart npm start, and pick "Local Wi-Fi" on the dashboard.
const http = require('http');

const PORT = Number(process.env.SIM_PORT) || 8080;
const ALL = process.argv.includes('--all');
const TICK_MS = 2000;

// --all sensors, one line each: [start, min, max, step per tick, unit]. Add a line and a new card appears.
const EXTRA = {
  temperature: [31, 24, 38, 0.15, '°C'],
  humidity: [62, 35, 90, 0.6, '%'],
  soil: [41, 10, 80, 0.8, '% est.'],
  light: [5400, 500, 60000, 400, 'lux'],
};

const state = Object.fromEntries(Object.entries(EXTRA).map(([k, [start]]) => [k, start]));
const CENTER = { lat: 13.0827, lon: 80.2707 };
const started = Date.now();
let gas = 900, tilt = 4, step = 0, gps = null;

// the "sensors" change on their own clock, whether or not anyone asks
setInterval(() => {
  gas = Math.round(Math.min(4095, Math.max(200, gas + (Math.random() * 2 - 1) * 40)));
  tilt = Math.round(Math.min(180, Math.max(0, tilt + (Math.random() * 2 - 1) * 1.5)) * 10) / 10;
  for (const [key, [, min, max, size]] of Object.entries(EXTRA)) {
    state[key] = Math.min(max, Math.max(min, state[key] + (Math.random() * 2 - 1) * size));
  }
  const a = (step++ / 90) * 2 * Math.PI; // ~60 m loop, one lap every 3 minutes
  gps = {
    lat: +(CENTER.lat + 0.0005 * Math.sin(a)).toFixed(6),
    lon: +(CENTER.lon + 0.0006 * Math.cos(a) * (1 + 0.3 * Math.sin(3 * a))).toFixed(6),
    valid: true,
  };
}, TICK_MS);

http.createServer((req, res) => {
  if (req.method !== 'GET' || req.url.split('?')[0] !== '/data') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found. Try /data');
  }
  const readings = { gas: { value: gas, unit: 'ADC' }, tilt: { value: tilt, unit: '°' } };
  const body = { device: 'agrifly-sim', readings, uptime: Math.round((Date.now() - started) / 1000) };
  if (ALL) {
    for (const [key, cfg] of Object.entries(EXTRA)) readings[key] = { value: Math.round(state[key] * 10) / 10, unit: cfg[4] };
    if (gps) body.gps = gps;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  console.log(`${new Date().toLocaleTimeString()}  served /data  gas=${gas} tilt=${tilt}${ALL ? ` temperature=${readings.temperature.value}` : ''}`);
}).listen(PORT, () => {
  console.log(`Fake ESP32 (${ALL ? 'gas, tilt + temperature, humidity, soil, light, GPS' : 'gas and tilt'}) at http://localhost:${PORT}/data`);
  console.log(`Set ESP_HOST=localhost:${PORT} in .env, restart npm start, and choose "Local Wi-Fi" on the dashboard.`);
});
