// Landing hero: a drone camera view with a Betaflight-style OSD.
//  - Live drone: shows the latest real reading from /api/latest.
//  - Fly the demo: the visitor steers over a simulated field; readings change by zone.
// Opens in live mode when the drone sent data in the last 10 s, otherwise in the demo.
(() => {
  const $ = (id) => document.getElementById(id);
  const feed = $('feed');
  const OFFLINE_AFTER_MS = 10000;
  const ROW_M = 0.75;                 // crop row spacing in metres
  const CENTER = { lat: 13.0827, lon: 80.2707 };
  const SHORT = { ir: 'IR', temperature: 'TEMP', humidity: 'HUM', pressure: 'PRES', light: 'LUX', soil: 'SOIL', gas_raw: 'GAS' };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let mode = 'demo', userChose = false, live = null; // live = { record, age }
  const fly = { x: 0, y: 0, steer: 0, speed: reduceMotion ? 0 : 5, alt: 8, trail: [] };

  // ---------- simulated field: smooth dry/wet zones ----------
  function soilAt(x, y) {
    const m = 46 + 24 * Math.sin(x / 70 + 0.6) * Math.cos(y / 120) + 12 * Math.sin((x + y) / 45) + 6 * Math.cos(y / 33);
    return Math.min(95, Math.max(5, m));
  }
  function demoReadings() {
    const m = soilAt(fly.x, fly.y);
    const t = 33.5 - m * 0.07 + 0.8 * Math.sin(fly.y / 90);
    return {
      temperature: { value: t, unit: '°C' },
      humidity: { value: 40 + m * 0.42, unit: '%' },
      soil: { value: m, unit: '% est.' },
      light: { value: 48000 + 9000 * Math.sin(fly.x / 55) - fly.alt * 60, unit: 'lux' },
    };
  }
  const demoGps = () => {
    const lat = CENTER.lat + fly.y / 111320;
    return { lat, lon: CENTER.lon + fly.x / (111320 * Math.cos(lat * Math.PI / 180)) };
  };

  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => `rgb(${hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t)).join(',')})`;
  const zone = (m) => [mix('#b8a057', '#2e7d3c', m / 100), mix('#9d8444', '#226431', m / 100)];

  // ---------- OSD ----------
  const line = (text) => Object.assign(document.createElement('div'), { textContent: text });
  const fmt = (v) => AgriFly.format(v);
  const latLon = (g) => [`${Math.abs(g.lat).toFixed(5)} ${g.lat >= 0 ? 'N' : 'S'}`, `${Math.abs(g.lon).toFixed(5)} ${g.lon >= 0 ? 'E' : 'W'}`];

  let sensors = []; // config/sensors.json, for labels and on/off text of binary sensors
  fetch('/api/sensors').then((r) => r.json()).then((s) => { sensors = s; }).catch(() => {});

  function readingRows(readings) {
    return Object.entries(readings).slice(0, 4).map(([key, { value, unit }]) => {
      const s = sensors.find((x) => x.key === key);
      const text = s?.type === 'binary' ? (value ? s.onText || 'ON' : s.offText || 'OFF') : `${fmt(value)} ${unit}`.trim();
      const row = document.createElement('div');
      const span = (t) => Object.assign(document.createElement('span'), { textContent: t });
      row.append(span(SHORT[key] || key.replace(/_/g, ' ').slice(0, 5)), span(text));
      return row;
    });
  }

  function setLink(text, ok) {
    $('osd-link').textContent = text;
    $('osd-link').className = ok ? 'link-ok' : 'link-lost';
  }

  function showAlert(title, detail) {
    $('osd-alert').hidden = !title;
    if (!title) return;
    $('osd-alert').firstChild.textContent = title;
    $('osd-alert').querySelector('small').textContent = detail;
  }

  function renderOsd() {
    if (mode === 'demo') {
      $('osd-device').textContent = 'DEMO FLIGHT';
      setLink('SIMULATED', false);
      $('osd-time').textContent = new Date().toLocaleTimeString([], { hour12: false });
      showAlert(null);
      $('osd-readings').replaceChildren(...readingRows(demoReadings()));
      $('osd-gps').replaceChildren(line(`ALT ${fly.alt} M`), line(`SPD ${fly.speed} M/S`), ...latLon(demoGps()).map(line));
      return;
    }
    if (!live) {
      setLink('NO LINK', false);
      showAlert('NO SIGNAL', 'TRY FLY THE DEMO');
      $('osd-readings').replaceChildren();
      $('osd-gps').replaceChildren();
      return;
    }
    const r = live.record;
    $('osd-device').textContent = r.source === 'blynk' ? 'BLYNK CLOUD' : r.device;
    $('osd-time').textContent = new Date(r.t).toLocaleTimeString([], { hour12: false });
    if (live.age > OFFLINE_AFTER_MS) {
      setLink('NO LINK', false);
      showAlert('DEVICE OFFLINE', `LAST DATA ${AgriFly.ago(live.age)}`);
      $('osd-readings').replaceChildren();
      $('osd-gps').replaceChildren();
      return;
    }
    setLink('LINK OK', true);
    showAlert(null);
    $('osd-readings').replaceChildren(...readingRows(r.readings));
    $('osd-gps').replaceChildren(...(r.gps ? latLon(r.gps) : ['NO GPS FIX']).map(line));
  }

  // ---------- minimap (demo) ----------
  const mapCtx = $('minimap').getContext('2d');
  function drawMinimap() {
    const size = 120, cell = 6, span = 420; // metres across
    const mPerPx = span / size;
    for (let py = 0; py < size; py += cell) {
      for (let px = 0; px < size; px += cell) {
        const wx = fly.x + (px + cell / 2 - size / 2) * mPerPx;
        const wy = fly.y - (py + cell / 2 - size / 2) * mPerPx; // north is up
        mapCtx.fillStyle = mix('#e2c260', '#14562a', soilAt(wx, wy) / 100); // stronger than the ground tint so zones read at this size
        mapCtx.fillRect(px, py, cell, cell);
      }
    }
    mapCtx.fillStyle = '#fff';
    for (const p of fly.trail) {
      mapCtx.fillRect(size / 2 + (p.x - fly.x) / mPerPx - 1, size / 2 - (p.y - fly.y) / mPerPx - 1, 2, 2);
    }
    mapCtx.beginPath();
    mapCtx.moveTo(60, 52); mapCtx.lineTo(66, 66); mapCtx.lineTo(54, 66); mapCtx.closePath();
    mapCtx.fillStyle = '#e8a92a'; mapCtx.strokeStyle = '#000'; mapCtx.lineWidth = 1.5;
    mapCtx.fill(); mapCtx.stroke();
  }

  // ---------- flight loop ----------
  let lastFrame = performance.now(), lastOsd = 0, lastMap = 0, lastTrail = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (mode === 'demo') {
      fly.x += fly.steer * 6 * dt;
      fly.y += fly.speed * dt;
    } else if (!reduceMotion) {
      fly.y += 5 * dt;
    }
    const rowPx = 34 * (8 / fly.alt);
    const pxPerM = rowPx / ROW_M;
    feed.style.setProperty('--row', `${rowPx.toFixed(2)}px`);
    feed.style.setProperty('--x', `${(-(fly.x * pxPerM) % rowPx).toFixed(2)}px`);
    feed.style.setProperty('--y', `${((fly.y * pxPerM) % (rowPx * 3.5)).toFixed(2)}px`);
    feed.style.setProperty('--roll', `${mode === 'demo' ? -fly.steer * 7 : 0}deg`);
    if (mode === 'demo') {
      const [crop, dark] = zone(soilAt(fly.x, fly.y));
      feed.style.setProperty('--crop', crop);
      feed.style.setProperty('--crop-dark', dark);
      if (now - lastTrail > 400) { lastTrail = now; fly.trail.push({ x: fly.x, y: fly.y }); if (fly.trail.length > 90) fly.trail.shift(); }
      if (now - lastMap > 100) { lastMap = now; drawMinimap(); }
      if (now - lastOsd > 250) { lastOsd = now; renderOsd(); }
    }
    requestAnimationFrame(frame);
  }

  // ---------- modes ----------
  // The server polls Blynk only while someone watches; "Live drone" is a watcher, the demo is not.
  let watch = null;
  function setMode(next, byUser) {
    mode = next;
    if (mode === 'live' && !watch) {
      watch = new EventSource('/api/stream?source=blynk');
      watch.onmessage = () => poll();
    } else if (mode === 'demo' && watch) {
      watch.close();
      watch = null;
    }
    if (byUser) userChose = true;
    $('mode-live').setAttribute('aria-pressed', String(mode === 'live'));
    $('mode-demo').setAttribute('aria-pressed', String(mode === 'demo'));
    $('controls').hidden = mode !== 'demo';
    $('minimap').hidden = mode !== 'demo';
    if (mode === 'live') {
      feed.style.removeProperty('--crop');
      feed.style.removeProperty('--crop-dark');
      fly.steer = 0;
    }
    updateNotes();
    renderOsd();
  }

  function updateNotes() {
    const droneLive = live && live.age <= OFFLINE_AFTER_MS;
    $('mode-hint').textContent = mode === 'demo'
      ? (droneLive ? 'The drone is sending data now. Switch to Live drone to see it.' : 'Steer over the field and watch the readings change by zone.')
      : (droneLive ? 'Showing the real drone, updated every 2 seconds.' : 'The drone is not sending data. Fly the demo instead.');
    $('feed-note').textContent = mode === 'demo'
      ? 'Demo readings are simulated from a made-up field. Real readings appear in Live drone mode.'
      : 'Real readings from the drone, drawn like the pilot’s on-screen display.';
  }

  // "How it works": a dot runs drone -> ESP32 -> dashboard for each new reading
  let pulsedT = 0;
  function pulse() {
    if (reduceMotion) return;
    const path = $('path');
    path.classList.remove('pulse');
    void path.offsetWidth; // restart the CSS animation
    path.classList.add('pulse');
  }

  async function poll() {
    // Blynk Cloud first, local Wi-Fi as well; show whichever has the newer reading
    try {
      const both = await Promise.all(['blynk', 'local'].map((s) => fetch(`/api/latest?source=${s}`, { cache: 'no-store' }).then((r) => r.json())));
      const best = both.filter((d) => d.latest).sort((a, b) => b.latest.t - a.latest.t)[0];
      live = best ? { record: best.latest, age: best.now - best.latest.t } : null;
    } catch {
      live = null;
    }
    if (mode === 'demo') pulse();
    else if (live && live.record.t !== pulsedT) { pulsedT = live.record.t; pulse(); }
    if (!userChose) {
      const droneLive = live && live.age <= OFFLINE_AFTER_MS;
      if ((droneLive ? 'live' : 'demo') !== mode) setMode(droneLive ? 'live' : 'demo', false);
    }
    updateNotes();
    if (mode === 'live') renderOsd();
  }

  // ---------- inputs ----------
  $('mode-live').addEventListener('click', () => setMode('live', true));
  $('mode-demo').addEventListener('click', () => setMode('demo', true));

  const speed = $('speed'), alt = $('alt');
  speed.value = fly.speed;
  const syncSliders = () => {
    fly.speed = Number(speed.value); fly.alt = Number(alt.value);
    $('speed-out').textContent = `${fly.speed} m/s`;
    $('alt-out').textContent = `${fly.alt} m`;
  };
  speed.addEventListener('input', syncSliders);
  alt.addEventListener('input', syncSliders);
  syncSliders();

  for (const btn of document.querySelectorAll('[data-steer]')) {
    const dir = Number(btn.dataset.steer);
    const stop = () => { fly.steer = 0; btn.classList.remove('held'); };
    btn.addEventListener('pointerdown', (e) => { btn.setPointerCapture(e.pointerId); fly.steer = dir; btn.classList.add('held'); });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    // keyboard activation: a short nudge
    btn.addEventListener('click', (e) => { if (e.detail === 0) { fly.steer = dir; setTimeout(() => { fly.steer = 0; }, 350); } });
  }

  const KEYS = { ArrowLeft: -1, a: -1, A: -1, ArrowRight: 1, d: 1, D: 1 };
  feed.addEventListener('keydown', (e) => {
    if (mode !== 'demo') return;
    if (e.key in KEYS) { fly.steer = KEYS[e.key]; e.preventDefault(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      speed.value = Number(speed.value) + (e.key === 'ArrowUp' ? 1 : -1);
      syncSliders();
      e.preventDefault();
    }
    // W / S: climb and descend (the range input clamps to its 3-30 m limits)
    const climb = { w: 1, W: 1, s: -1, S: -1 }[e.key];
    if (climb) {
      alt.value = Number(alt.value) + climb;
      syncSliders();
      e.preventDefault();
    }
  });
  feed.addEventListener('keyup', (e) => { if (e.key in KEYS) fly.steer = 0; });
  feed.addEventListener('blur', () => { fly.steer = 0; });

  $('fly-link').addEventListener('click', (e) => {
    e.preventDefault();
    setMode('demo', true);
    feed.focus();
  });

  // tabs (How it works / Why AgriFly / Team), arrow keys move between them
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function openTab(tab) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    }
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => openTab(tab));
    tab.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const next = tabs[(i + step + tabs.length) % tabs.length];
      openTab(next);
      next.focus();
    });
  });

  setMode('demo', false);
  poll();
  setInterval(poll, 2000);
  requestAnimationFrame(frame);
})();
