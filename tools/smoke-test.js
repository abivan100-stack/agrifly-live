// npm test: runs the server against a fake Blynk API and a fake ESP32, and checks that each source
// is polled only while a dashboard watches it.
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PORT = 3999, BLYNK_PORT = 3998, ESP_PORT = 3997;
const BASE = `http://localhost:${PORT}`;
const BLYNK_TOKEN = 'test-blynk-token-123';
const dataFile = path.join(os.tmpdir(), `agrifly-test-${process.pid}.jsonl`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fake Blynk: V0 = 1 (IR), V10 = the fake ESP32's address, device online
let blynkGets = 0, sawToken = true;
const fakeBlynk = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('token') !== BLYNK_TOKEN) sawToken = false;
  if (url.pathname === '/external/api/isHardwareConnected') return res.end('true');
  if (url.pathname === '/external/api/get') {
    blynkGets++;
    return res.end(url.searchParams.has('v10') ? `localhost:${ESP_PORT}` : '1');
  }
  res.statusCode = 404; res.end('{"error":{"message":"not found"}}');
}).listen(BLYNK_PORT);

// fake ESP32: GET /data
let espGets = 0;
const fakeEsp = http.createServer((req, res) => {
  espGets++;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ device: 'agrifly-01', readings: { ir: { value: 1, unit: '' }, temperature: 30.5 }, uptime: 5 }));
}).listen(ESP_PORT);

function startServer(extraEnv) {
  return spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, ESP_HOST: '', PORT, DATA_FILE: dataFile, BLYNK_TOKEN, BLYNK_SERVER: `http://localhost:${BLYNK_PORT}`, BLYNK_POLL_MS: '1000', LOCAL_POLL_MS: '500', ...extraEnv },
    stdio: 'ignore',
  });
}

const json = async (p) => (await fetch(BASE + p)).json();

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/sensors`); return; } catch { await sleep(100); }
  }
  throw new Error('server did not start');
}

async function firstEvent(source) {
  const reader = (await fetch(`${BASE}/api/stream?source=${source}`)).body.getReader();
  let text = '';
  while (!text.includes('data:')) text += new TextDecoder().decode((await reader.read()).value);
  return { reader, event: JSON.parse(text.slice(text.indexOf('data:') + 5).split('\n')[0]) };
}

let server;
(async () => {
  try {
    // ---- run 1: ESP_HOST set ----
    server = startServer({ ESP_HOST: `localhost:${ESP_PORT}` });
    await waitForServer();

    assert.equal((await fetch(`${BASE}/api/data`, { method: 'POST' })).status, 404, 'push endpoint is gone');
    await sleep(1500);
    assert.equal(blynkGets + espGets, 0, 'no polling at all while no dashboard is open');
    let status = await json('/api/status');
    assert.ok(!JSON.stringify(status).includes(BLYNK_TOKEN), 'token never in /api/status');
    assert.ok(!JSON.stringify(await json('/api/sensors')).includes(BLYNK_TOKEN), 'token never in /api/sensors');

    // Blynk source
    let { reader, event } = await firstEvent('blynk');
    assert.equal(event.source, 'blynk');
    assert.deepEqual(event.readings, { ir: { value: 1, unit: '' } }, 'V0 mapped to ir via sensors.json');
    assert.ok(sawToken, 'server sent the token to Blynk');
    assert.equal(espGets, 0, 'Blynk dashboard does not poll the ESP32');
    reader.cancel();
    await sleep(2500);
    const blynkAfter = blynkGets;
    await sleep(2000);
    assert.equal(blynkGets, blynkAfter, 'Blynk polling stops when the Blynk dashboard closes');

    // Local source via ESP_HOST
    ({ reader, event } = await firstEvent('local'));
    assert.equal(event.source, 'local');
    assert.equal(event.device, 'agrifly-01');
    assert.deepEqual(event.readings, { ir: { value: 1, unit: '' }, temperature: { value: 30.5, unit: '' } });
    status = await json('/api/status');
    assert.deepEqual([status.local.host, status.local.hostSource, status.local.reachable], [`localhost:${ESP_PORT}`, 'env', true]);
    assert.equal(blynkGets, blynkAfter, 'ESP_HOST set: no Blynk call needed for local mode');
    reader.cancel();
    await sleep(1500);
    const espAfter = espGets;
    await sleep(1500);
    assert.equal(espGets, espAfter, 'local polling stops when the Local dashboard closes');
    server.kill();

    // ---- run 2: no ESP_HOST, address comes from Blynk V10 ----
    server = startServer({});
    await waitForServer();
    ({ reader, event } = await firstEvent('local'));
    assert.equal(event.source, 'local');
    status = await json('/api/status');
    assert.deepEqual([status.local.host, status.local.hostSource], [`localhost:${ESP_PORT}`, 'blynk'], 'ESP32 address read from Blynk V10');
    reader.cancel();

    await sleep(200); // appendFile is async
    const sources = fs.readFileSync(dataFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l).source);
    assert.ok(sources.includes('local') && sources.includes('blynk'), 'both sources persisted');
    server.kill();

    // ---- run 3: Vercel mode, in-process (Vercel imports the app; it never listens or polls by itself) ----
    const vercelFile = path.join(os.tmpdir(), `agrifly-vercel-${process.pid}.jsonl`);
    Object.assign(process.env, { VERCEL: '1', BLYNK_TOKEN, BLYNK_SERVER: `http://localhost:${BLYNK_PORT}`, BLYNK_POLL_MS: '3000', DATA_FILE: vercelFile });
    const serverPath = require.resolve('../server.js');
    const VPORT = 3996, V = `http://localhost:${VPORT}`;
    const listen = (app, port = VPORT) => new Promise((r) => { const srv = app.listen(port, () => r(srv)); });
    let vServer = await listen(require(serverPath));
    assert.deepEqual(await (await fetch(`${V}/api/config`)).json(), { deployment: 'vercel', localModeAvailable: false, pollMs: 3000 });
    const gets = blynkGets;
    const first = await fetch(`${V}/api/latest?source=blynk`);
    assert.equal(first.headers.get('cache-control'), 'public, s-maxage=3, stale-while-revalidate=10', 'CDN may share the answer');
    const body = await first.text();
    assert.ok(!body.includes(BLYNK_TOKEN), 'token never in /api/latest');
    const latest = JSON.parse(body);
    assert.deepEqual([latest.deviceOnline, latest.readings, latest.latest.readings], [true, { ir: { value: 1, unit: '' } }, { ir: { value: 1, unit: '' } }]);
    await Promise.all([1, 2, 3, 4, 5].map(() => fetch(`${V}/api/latest?source=blynk`)));
    assert.equal(blynkGets - gets, 1, 'six viewers within 3 s cost one Blynk values request');
    assert.equal((await fetch(`${V}/api/stream?source=blynk`)).status, 404, 'no SSE on Vercel');
    assert.equal((await fetch(`${V}/api/latest?source=local`)).status, 400, 'no Local Wi-Fi on Vercel');
    assert.ok(!fs.existsSync(vercelFile), 'nothing written to disk on Vercel');
    vServer.closeAllConnections(); vServer.close();

    // missing token: a clear JSON error, not a crash
    process.env.BLYNK_TOKEN = '';
    delete require.cache[serverPath];
    vServer = await listen(require(serverPath), VPORT - 1); // fresh port: fetch may reuse a socket to the old one
    const missing = await fetch(`http://localhost:${VPORT - 1}/api/latest?source=blynk`);
    assert.equal(missing.status, 503);
    assert.match((await missing.json()).error, /BLYNK_TOKEN is not set/);
    vServer.closeAllConnections(); vServer.close();
    console.log('smoke test passed');
  } catch (err) {
    console.error('smoke test FAILED:', err.message, err.cause?.code || '', err.stack?.split('\n').find((l) => l.includes('smoke-test.js:')) || '');
    process.exitCode = 1;
  } finally {
    server?.kill();
    fakeBlynk.close();
    fakeEsp.close();
    fs.rmSync(dataFile, { force: true });
  }
})();
