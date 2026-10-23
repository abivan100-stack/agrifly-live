// config/sensors.json and the rules for turning raw values into readings. Used by the server in both modes.
const SENSORS = require('../config/sensors.json');

const BLYNK_PINS = SENSORS.filter((s) => s.blynkPin);

// what browsers may see (no Blynk pin numbers)
const publicSensors = () => SENSORS.map(({ key, label, unit, type, onText, offText }) => ({ key, label, unit, type, onText, offText }));

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

module.exports = { SENSORS, BLYNK_PINS, publicSensors, normalizeReadings, normalizeGps };
