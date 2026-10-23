// npm test: starts the server on a spare port with a temp data file and checks the API.
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const dataFile = path.join(os.tmpdir(), `agrifly-test-${process.pid}.jsonl`);
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, AGRIFLY_TOKEN: 'test-token', DATA_FILE: dataFile },
  stdio: 'ignore',
});

const post = (body) => fetch(`${BASE}/api/data`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/latest`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
}

(async () => {
  try {
    await waitForServer();

    assert.equal((await post({ token: 'wrong', readings: { t: 1 } })).status, 401, 'bad token rejected');
    assert.equal((await post({ token: 'test-token', readings: { t: 'abc' } })).status, 400, 'non-numeric rejected');

    const sse = await fetch(`${BASE}/api/stream`);
    const reader = sse.body.getReader();

    const ok = await post({
      device: 'test', token: 'test-token',
      readings: { temperature: { value: 31.4, unit: '°C' }, soil: 41, bad: 'x' },
      gps: { lat: 0, lon: 0, valid: false },
    });
    assert.deepEqual(await ok.json(), { ok: true });

    let streamed = '';
    while (!streamed.includes('data:')) streamed += new TextDecoder().decode((await reader.read()).value);
    reader.cancel();
    assert.match(streamed, /"temperature"/, 'SSE broadcast');

    const { latest } = await (await fetch(`${BASE}/api/latest`)).json();
    assert.deepEqual(latest.readings, { temperature: { value: 31.4, unit: '°C' }, soil: { value: 41, unit: '' } });
    assert.equal(latest.gps, null, 'invalid GPS dropped, never 0,0');

    await post({ device: 'test', token: 'test-token', readings: { co2: 420 }, gps: { lat: 13.08, lon: 80.27, valid: true } });
    const { readings } = await (await fetch(`${BASE}/api/history?limit=10`)).json();
    assert.equal(readings.length, 2);
    assert.deepEqual(readings[1].gps, { lat: 13.08, lon: 80.27 });

    const csv = await (await fetch(`${BASE}/api/export.csv`)).text();
    const [header, row1] = csv.replace(/^﻿/, '').split('\n');
    assert.equal(header, 'time,device,lat,lon,temperature (°C),soil,co2');
    assert.match(row1, /,test,,,31.4,41,$/);

    await new Promise((r) => setTimeout(r, 200)); // appendFile is async
    assert.equal(fs.readFileSync(dataFile, 'utf8').trim().split('\n').length, 2, 'JSONL persisted');
    console.log('smoke test passed');
  } catch (err) {
    console.error('smoke test FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    server.kill();
    fs.rmSync(dataFile, { force: true });
  }
})();
