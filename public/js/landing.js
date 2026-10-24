// Landing hero: a drone camera view with a Betaflight-style OSD.
//  - Live drone: shows the latest real reading from /api/latest.
//  - Fly the demo: the visitor flies over a simulated farm (perspective render in field-view.js, quadcopter
//    physics below); readings change by soil zone.
// Opens in live mode when the drone sent data in the last 10 s, otherwise in the demo.
(() => {
  const $ = (id) => document.getElementById(id);
  const feed = $('feed');
  const OFFLINE_AFTER_MS = 10000;
  const CENTER = { lat: 13.0827, lon: 80.2707 };
  const SHORT = { ir: 'IR', temperature: 'TEMP', humidity: 'HUM', pressure: 'PRES', light: 'LUX', soil: 'SOIL', gas_raw: 'GAS' };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let mode = 'demo', userChose = false, live = null; // live = { record, age }
  let cloud = false, pollMs = 1000; // on Vercel: Blynk only, no SSE, pause while the tab is hidden
  // demo flight state. speed/alt are what the sliders ask for; the drone eases towards them like a real quad.
  const fly = {
    x: 40, y: 0, heading: 0, vx: 0, vy: 0, alt: 8, vz: 0, yawRate: 0, pitch: 0, roll: 0, // starts over crop rows, not a track
    steer: 0, speed: reduceMotion ? 0 : 5, altSet: 8, trail: [],
  };

  // ---------- simulated field: smooth dry/wet zones (shared with the camera view in field-view.js) ----------
  const { soilAt } = FieldView;
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
      const hdg = String(Math.round(((fly.heading * 180 / Math.PI) % 360 + 360) % 360) % 360).padStart(3, '0');
      $('osd-gps').replaceChildren(line(`ALT ${fly.alt.toFixed(1)} M`), line(`SPD ${Math.hypot(fly.vx, fly.vy).toFixed(1)} M/S`),
        line(`HDG ${hdg}`), ...latLon(demoGps()).map(line));
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
    // the drone, pointing where it is heading (map is north-up)
    mapCtx.save();
    mapCtx.translate(60, 60);
    mapCtx.rotate(fly.heading);
    mapCtx.beginPath();
    mapCtx.moveTo(0, -8); mapCtx.lineTo(6, 6); mapCtx.lineTo(-6, 6); mapCtx.closePath();
    mapCtx.fillStyle = '#e8a92a'; mapCtx.strokeStyle = '#000'; mapCtx.lineWidth = 1.5;
    mapCtx.fill(); mapCtx.stroke();
    mapCtx.restore();
  }

  // ---------- flight physics ----------
  // A simple quadcopter: steering turns it (yaw), speed is reached with limited acceleration so it drifts in
  // turns, and the body tilts into the thrust it needs (accelerating, holding speed against drag, turning),
  // which banks and pitches the camera. Altitude eases to the slider at a limited climb rate.
  const PHYS = {
    g: 9.81,
    maxYawRate: 0.85,   // rad/s at full steer (about 49 degrees per second)
    yawTau: 0.3,        // s, how quickly the turn rate builds up
    accelK: 1.1,        // 1/s, how hard it chases the target speed
    maxAccel: 5,        // m/s^2
    dragK: 0.22,        // 1/s, air drag the motors push against
    climbK: 1.2,        // 1/s
    maxClimb: 3,        // m/s
    climbTau: 0.35,     // s
    attTau: 0.18,       // s, how quickly the body tilt follows
    camDown: 0.12,      // rad, the camera's downward tilt when hovering (about 7 degrees)
  };

  function step(dt, steer, speedSet, altSet) {
    const P = PHYS;
    fly.yawRate += (steer * P.maxYawRate - fly.yawRate) * (1 - Math.exp(-dt / P.yawTau));
    fly.heading += fly.yawRate * dt;
    const hx = Math.sin(fly.heading), hy = Math.cos(fly.heading);
    let ax = (hx * speedSet - fly.vx) * P.accelK, ay = (hy * speedSet - fly.vy) * P.accelK;
    const a = Math.hypot(ax, ay);
    if (a > P.maxAccel) { ax *= P.maxAccel / a; ay *= P.maxAccel / a; }
    fly.vx += ax * dt; fly.vy += ay * dt;
    fly.x += fly.vx * dt; fly.y += fly.vy * dt;
    const vzSet = Math.max(-P.maxClimb, Math.min(P.maxClimb, (altSet - fly.alt) * P.climbK));
    fly.vz += (vzSet - fly.vz) * (1 - Math.exp(-dt / P.climbTau));
    fly.alt += fly.vz * dt;
    // horizontal thrust = acceleration + drag; split into forward (nose down) and sideways (bank)
    const tx = ax + P.dragK * fly.vx, ty = ay + P.dragK * fly.vy;
    const forward = tx * hx + ty * hy, right = tx * hy - ty * hx;
    const b = 1 - Math.exp(-dt / P.attTau);
    fly.pitch += (Math.atan2(forward, P.g) - fly.pitch) * b;
    fly.roll += (Math.atan2(right, P.g) - fly.roll) * b;
  }

  // ---------- flight loop ----------
  const view = FieldView.createView($('view')); // draws on background workers when it can
  // only draw while the camera is on screen (phones scroll past it); the flight itself keeps going
  let feedVisible = true;
  if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { feedVisible = e.isIntersecting; }).observe(feed);
  let lastFrame = performance.now(), lastOsd = 0, lastMap = 0, lastTrail = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    if (mode === 'demo') step(dt, fly.steer, fly.speed, fly.altSet);
    else step(dt, 0, reduceMotion ? 0 : 5, 8); // live: a calm, straight survey pass behind the real readings
    // a little motor vibration, stronger at speed (none with reduced motion)
    const t = now / 1000;
    const buzz = reduceMotion ? 0 : 0.0018 * (0.5 + Math.hypot(fly.vx, fly.vy) / 12);
    if (feedVisible) view.render({
      x: fly.x, y: fly.y, alt: Math.max(0.5, fly.alt), heading: fly.heading, time: t,
      pitch: PHYS.camDown + fly.pitch + buzz * (Math.sin(t * 41) + Math.sin(t * 67 + 1)),
      roll: fly.roll + buzz * (Math.sin(t * 53 + 2) + Math.sin(t * 29)),
    });
    if (mode === 'demo') {
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
    if (mode === 'live' && !watch && !cloud) {
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
    if (mode === 'live') fly.steer = 0;
    updateNotes();
    renderOsd();
  }

  function updateNotes() {
    const droneLive = live && live.age <= OFFLINE_AFTER_MS;
    $('mode-hint').textContent = mode === 'demo'
      ? (droneLive ? 'The drone is sending data now. Switch to Live drone to see it.' : 'Steer over the field and watch the readings change by zone.')
      : (droneLive ? `Showing the real drone, updated every ${pollMs / 1000} second${pollMs === 1000 ? "" : "s"}.` : 'The drone is not sending data. Fly the demo instead.');
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
    if (cloud && document.visibilityState !== 'visible') return; // save Blynk quota
    // Blynk Cloud first, local Wi-Fi as well (only with npm start); show whichever has the newer reading
    try {
      const sources = cloud ? ['blynk'] : ['blynk', 'local'];
      // on Vercel the response is CDN-cached, so let the browser cache rules apply instead of forcing no-store
      const both = await Promise.all(sources.map((s) => fetch(`/api/latest?source=${s}`, cloud ? {} : { cache: 'no-store' }).then((r) => r.json())));
      const best = both.filter((d) => d.latest).sort((a, b) => b.latest.t - a.latest.t)[0];
      // a cached response carries an old `now`, so on Vercel age is measured with this device's clock
      live = best ? { record: best.latest, age: (cloud ? Date.now() : best.now) - best.latest.t } : null;
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
    fly.speed = Number(speed.value); fly.altSet = Number(alt.value);
    $('speed-out').textContent = `${fly.speed} m/s`;
    $('alt-out').textContent = `${fly.altSet} m`;
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
  requestAnimationFrame(frame);
  fetch('/api/config').then((r) => r.json()).then((c) => {
    cloud = c.deployment === 'vercel';
    if (cloud) pollMs = c.pollMs || 2000;
  }).catch(() => { /* older server: behave as local */ }).finally(() => {
    poll();
    setInterval(poll, pollMs);
  });
})();
