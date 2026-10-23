// npm test: starts the server against a fake Blynk API and checks both data sources.
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PORT = 3999, BLYNK_PORT = 3998;
const BASE = `http://localhost:${PORT}`;
const BLYNK_TOKEN = 'test-blynk-token-123';
const dataFile = path.join(os.tmpdir(), `agrifly-test-${process.pid}.jsonl`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fake Blynk: V0 = 1, device online; counts value reads so we can check polling starts and stops
let blynkGets = 0, sawToken = true;
const fakeBlynk = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('token') !== BLYNK_TOKEN) sawToken = false;
  if (url.pathname === '/external/api/isHardwareConnected') return res.end('true');
  if (url.pathname === '/external/api/get') { blynkGets++; return res.end('1'); }
  res.statusCode = 404; res.end('{"error":{"message":"not found"}}');
}).listen(BLYNK_PORT);

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, LOCAL_TOKEN: 'test-token', DATA_FILE: dataFile, BLYNK_TOKEN, BLYNK_SERVER: `http://localhost:${BLYNK_PORT}`, BLYNK_POLL_MS: '1000' },
  stdio: 'ignore',
});

const post = (body) => fetch(`${BASE}/api/data`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const json = async (p) => (await fetch(BASE + p)).json();

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/sensors`); return; } catch { await sleep(100); }
  }
  throw new Error('server did not start');
}

async function firstEvent(reader) {
  let text = '';
  while (!text.includes('data:')) text += new TextDecoder().decode((await reader.read()).value);
  return JSON.parse(text.slice(text.indexOf('data:') + 5).split('\n')[0]);
}

(async () => {
  try {
    await waitForServer();

    // ---- local source ----
    assert.equal((await post({ token: 'wrong', readings: { ir: 1 } })).status, 401, 'bad token rejected');
    assert.equal((await post({ token: 'test-token', readings: { ir: 'abc' } })).status, 400, 'non-numeric rejected');
    const localStream = (await fetch(`${BASE}/api/stream?source=local`)).body.getReader();
    assert.deepEqual(await (await post({ device: 'test', token: 'test-token', readings: { ir: 1, temperature: { value: 31.4, unit: '°C' } }, gps: { lat: 0, lon: 0, valid: false } })).json(), { ok: true });
    const ev = await firstEvent(localStream);
    localStream.cancel();
    assert.equal(ev.source, 'local');
    const { latest } = await json('/api/latest?source=local');
    assert.deepEqual(latest.readings, { ir: { value: 1, unit: '' }, temperature: { value: 31.4, unit: '°C' } });
    assert.equal(latest.gps, null, 'invalid GPS dropped, never 0,0');
    const csv = (await (await fetch(`${BASE}/api/export.csv?source=local`)).text()).replace(/^﻿/, '').split('\n');
    assert.equal(csv[0], 'time,source,device,lat,lon,ir,temperature (°C)');

    // ---- blynk source: no polling until someone watches ----
    await sleep(1500);
    assert.equal(blynkGets, 0, 'no Blynk calls while nobody watches');
    let status = await json('/api/status');
    assert.equal(status.blynk.configured, true);
    assert.ok(!JSON.stringify(status).includes(BLYNK_TOKEN), 'token never in /api/status');
    assert.ok(!JSON.stringify(await json('/api/sensors')).includes(BLYNK_TOKEN), 'token never in /api/sensors');

    const blynkStream = (await fetch(`${BASE}/api/stream?source=blynk`)).body.getReader();
    const bev = await firstEvent(blynkStream);
    assert.equal(bev.source, 'blynk');
    assert.deepEqual(bev.readings, { ir: { value: 1, unit: '' } }, 'V0 mapped to ir via sensors.json');
    assert.ok(sawToken, 'server sent the token to Blynk');
    status = await json('/api/status');
    assert.equal(status.blynk.deviceOnline, true);
    assert.equal(status.blynk.polling, true);

    blynkStream.cancel();
    await sleep(2500); // let the poller notice nobody is watching
    const after = blynkGets;
    await sleep(2500);
    assert.equal(blynkGets, after, 'Blynk polling stops when the dashboard closes');
    assert.equal((await json('/api/status')).blynk.polling, false);

    await sleep(200); // appendFile is async
    const sources = fs.readFileSync(dataFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l).source);
    assert.ok(sources.includes('local') && sources.includes('blynk'), 'both sources persisted');
    console.log('smoke test passed');
  } catch (err) {
    console.error('smoke test FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    server.kill();
    fakeBlynk.close();
    fs.rmSync(dataFile, { force: true });
  }
})();
