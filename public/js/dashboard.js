// Live dashboard. Cards come from config/sensors.json (via /api/sensors); any other key that arrives
// from the local source gets a card too, so a new sensor needs no code change here.
// Two sources: Blynk Cloud (default) and Local Wi-Fi, switched with the toggle at the top.
(() => {
  const { prettify, format, ago } = window.AgriFly;
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const LOCAL_OFFLINE_MS = 10000;
  const SPARK_POINTS = 40;
  const DETECTION_WINDOW_MS = 10 * 60000;
  const RAMP = ['#f0e7a1', '#c6d36a', '#7fae4f', '#3c7a3a', '#1c4a2a']; // map points: low -> high
  const STORAGE_KEY = 'agrifly-source';

  let sensors = [];          // from /api/sensors
  let source = 'blynk';
  let es = null;
  let records = [];          // sorted by server time t
  let clockOffset = 0;       // server clock - this device's clock
  let status = null;         // last /api/status
  let streamOk = true;
  const cards = new Map();   // key -> card parts
  let chart = null;
  let map = null, track = null, points = null, lastMarker = null, markers = [];

  const serverNow = () => Date.now() + clockOffset;
  const last = () => records.at(-1);
  const meta = (key) => sensors.find((s) => s.key === key)
    || { key, label: prettify(key), type: 'number', unit: records.findLast((r) => r.readings[key])?.readings[key].unit || '' };
  const isBinary = (key) => meta(key).type === 'binary';
  const stateText = (key, v) => (v ? meta(key).onText || 'On' : meta(key).offText || 'Off');

  // ---------- source switching ----------
  function setSource(next) {
    source = next;
    try { localStorage.setItem(STORAGE_KEY, source); } catch { /* storage blocked: still works for this visit */ }
    for (const b of document.querySelectorAll('[data-source]')) b.setAttribute('aria-pressed', String(b.dataset.source === source));
    $('csv').href = `/api/export.csv?source=${source}`;
    reset();
    connect();
    refreshStatus();
  }

  function reset() {
    records = [];
    for (const c of cards.values()) c.el.remove();
    cards.clear();
    $('chart-key').replaceChildren();
    if (map) { map.remove(); map = track = points = lastMarker = null; markers = []; }
    $('map').hidden = true;
    $('legend').hidden = true;
    $('no-gps').hidden = false;
    $('gps-meta').textContent = '';
    for (const s of sensors) ensureCard(s.key);
    syncChartOptions();
    updateChart();
    tick();
  }

  // SSE reconnects by itself; each (re)connect re-syncs history so no gap is left behind.
  function connect() {
    if (es) es.close();
    const mine = es = new EventSource(`/api/stream?source=${source}`);
    es.onopen = () => { streamOk = true; loadHistory(mine).catch((e) => console.error('history load failed', e)); };
    es.onmessage = (e) => { if (mine === es) onRecord(JSON.parse(e.data)); };
    es.onerror = () => { streamOk = false; tick(); };
  }

  async function loadHistory(forStream) {
    const want = source;
    const data = await (await fetch(`/api/history?source=${want}&limit=2000`, { cache: 'no-store' })).json();
    if (forStream !== es || want !== source) return; // switched source meanwhile
    clockOffset = data.now - Date.now();
    const newestLoaded = data.readings.at(-1)?.t ?? 0;
    records = data.readings.concat(records.filter((r) => r.t > newestLoaded));
    rebuild();
  }

  async function refreshStatus() {
    try {
      status = await (await fetch('/api/status', { cache: 'no-store' })).json();
      clockOffset = status.now - Date.now();
    } catch {
      status = null;
    }
    tick();
  }

  function onRecord(r) {
    if (last() && r.t <= last().t) return;
    records.push(r);
    if (records.length > 5000) records = records.slice(-2000);
    Object.keys(r.readings).forEach(ensureCard);
    for (const key of Object.keys(r.readings)) updateCard(key);
    syncChartOptions();
    updateChart();
    if (r.gps) { addGps(r, true); recolorMap(); }
    tick();
  }

  // One selection drives the cards, the chart and the map colours.
  function select(key) {
    $('chart-key').value = key;
    updateChart();
    recolorMap();
    for (const k of cards.keys()) updateCard(k);
  }

  // ---------- cards ----------
  function ensureCard(key) {
    if (cards.has(key)) return;
    const binary = isBinary(key);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = binary ? 'card binary' : 'card';
    el.innerHTML = binary
      ? '<div class="label"></div><div class="state off">No data yet</div><canvas></canvas><div class="detections"></div><div class="ago"></div>'
      : '<div class="label"></div><div class="value"><span>--</span><small></small></div><canvas></canvas><div class="ago">No data yet</div>';
    el.querySelector('.label').textContent = meta(key).label;
    el.addEventListener('click', () => select(key));
    // configured sensors first (in config order), then extra local keys alphabetically
    const order = (k) => { const i = sensors.findIndex((s) => s.key === k); return i < 0 ? 1000 : i; };
    const keys = [...cards.keys(), key].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
    const before = cards.get(keys[keys.indexOf(key) + 1]);
    $('cards').insertBefore(el, before ? before.el : null);
    cards.set(key, {
      el, binary,
      value: el.querySelector('.value span'),
      unit: el.querySelector('.value small'),
      state: el.querySelector('.state'),
      detections: el.querySelector('.detections'),
      spark: el.querySelector('canvas'),
      ago: el.querySelector('.ago'),
      lastT: 0,
    });
  }

  function updateCard(key) {
    const c = cards.get(key);
    const series = [];
    let latest = null;
    for (let i = records.length - 1; i >= 0 && series.length < SPARK_POINTS; i--) {
      const rd = records[i].readings[key];
      if (!rd) continue;
      if (!latest) latest = { ...rd, t: records[i].t };
      series.push(rd.value);
    }
    if (!latest) return;
    c.lastT = latest.t;
    if (c.binary) {
      const on = Boolean(latest.value);
      c.state.textContent = stateText(key, on);
      c.state.className = `state ${on ? 'on' : 'off'}`;
      const n = detections(key);
      c.detections.textContent = `${n} detection${n === 1 ? '' : 's'} in the last 10 min`;
    } else {
      c.value.textContent = format(latest.value);
      c.unit.textContent = latest.unit || meta(key).unit || '';
    }
    drawSpark(c.spark, series.reverse(), c.binary);
  }

  // rising edges (0 -> 1) in the last 10 minutes
  function detections(key) {
    const from = serverNow() - DETECTION_WINDOW_MS;
    let prev = null, count = 0;
    for (const r of records) {
      const rd = r.readings[key];
      if (!rd) continue;
      const v = rd.value ? 1 : 0;
      if (r.t >= from && prev === 0 && v === 1) count++;
      prev = v;
    }
    return count;
  }

  function drawSpark(canvas, values, stepped) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    if (values.length < 2) return;
    const min = stepped ? 0 : Math.min(...values), max = stepped ? 1 : Math.max(...values);
    const span = max - min || 1;
    const x = (i) => (i / (values.length - 1)) * (w - 2) + 1;
    const y = (v) => h - 3 - ((v - min) / span) * (h - 6);
    ctx.beginPath();
    values.forEach((v, i) => {
      if (!i) return ctx.moveTo(x(i), y(v));
      if (stepped) ctx.lineTo(x(i), y(values[i - 1]));
      ctx.lineTo(x(i), y(v));
    });
    ctx.strokeStyle = getComputedStyle(canvas).color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // ---------- main chart ----------
  function syncChartOptions() {
    const sel = $('chart-key');
    const current = sel.value;
    const keys = [...cards.keys()];
    if (keys.join() === [...sel.options].map((o) => o.value).join()) return;
    sel.replaceChildren(...keys.map((k) => new Option(meta(k).label, k)));
    sel.value = keys.includes(current) ? current : keys[0] || '';
  }

  function updateChart() {
    const key = $('chart-key').value;
    if (!key || typeof Chart === 'undefined') return;
    for (const [k, c] of cards) c.el.setAttribute('aria-pressed', String(k === key));
    const binary = isBinary(key);
    const range = Number($('chart-range').value);
    const from = range ? serverNow() - range : 0;
    const data = [];
    for (const r of records) {
      const rd = r.readings[key];
      if (r.t < from || !rd) continue;
      data.push({ x: r.t, y: binary ? (rd.value ? 1 : 0) : rd.value });
    }
    if (!chart) chart = makeChart();
    const ds = chart.data.datasets[0];
    ds.data = data;
    ds.label = meta(key).label;
    ds.stepped = binary ? 'before' : false;
    ds.cubicInterpolationMode = binary ? 'default' : 'monotone';
    const y = chart.options.scales.y;
    y.min = binary ? -0.1 : undefined;
    y.max = binary ? 1.1 : undefined;
    y.afterBuildTicks = binary ? (axis) => { axis.ticks = [{ value: 0 }, { value: 1 }]; } : undefined;
    y.ticks.callback = binary ? (v) => stateText(key, v === 1) : (v) => format(v);
    // don't stretch a few minutes of data across an empty 15 min / 1 h axis
    chart.options.scales.x.min = range && data.length ? Math.max(from, data[0].x) : undefined;
    chart.options.scales.x.max = data.length ? data.at(-1).x : undefined;
    chart.update('none');
  }

  function makeChart() {
    const text = css('--muted'), grid = css('--rule'), green = css('--field');
    Chart.defaults.font.family = css('--body');
    return new Chart($('chart'), {
      type: 'line',
      data: { datasets: [{ data: [], borderColor: green, backgroundColor: green + '22', fill: true, pointRadius: 0, borderWidth: 2 }] },
      options: {
        animation: false,
        maintainAspectRatio: false,
        parsing: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { display: false }, // the dropdown already names the series
          tooltip: { callbacks: {
            title: (items) => new Date(items[0].parsed.x).toLocaleTimeString(),
            label: (item) => {
              const key = $('chart-key').value;
              return isBinary(key) ? stateText(key, item.parsed.y === 1) : `${format(item.parsed.y)} ${meta(key).unit || ''}`.trim();
            },
          } },
        },
        scales: {
          x: { type: 'linear', ticks: { color: text, maxTicksLimit: innerWidth < 600 ? 3 : 7, maxRotation: 0, callback(v) {
            const short = this.max - this.min < 10 * 60000; // show seconds on short spans
            return new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: short ? '2-digit' : undefined });
          } }, grid: { color: grid } },
          y: { ticks: { color: text }, grid: { color: grid } },
        },
      },
    });
  }

  // ---------- map ----------
  function addGps(r, live) {
    if (typeof L === 'undefined') return;
    const ll = [r.gps.lat, r.gps.lon];
    if (!map) {
      $('no-gps').hidden = true;
      $('map').hidden = false;
      map = L.map('map').setView(ll, 17);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
      track = L.polyline([], { color: '#6b4226', weight: 2, opacity: 0.45 }).addTo(map);
      points = L.layerGroup().addTo(map);
      $('legend-ramp').style.background = `linear-gradient(to right, ${RAMP.join(', ')})`;
    }
    track.addLatLng(ll);
    const summary = Object.entries(r.readings).map(([k, v]) =>
      `${meta(k).label}: ${isBinary(k) ? stateText(k, v.value) : `${format(v.value)} ${v.unit}`}`).join('<br>');
    const marker = L.circleMarker(ll, { radius: 6, color: css('--ink'), weight: 1, fillOpacity: 0.95 })
      .bindTooltip(`<b>${new Date(r.t).toLocaleTimeString()}</b><br>${summary}`)
      .addTo(points);
    markers.push({ marker, r });
    if (!lastMarker) lastMarker = L.circleMarker(ll, { radius: 11, color: css('--ink'), weight: 3, fill: false, interactive: false }).addTo(map);
    lastMarker.setLatLng(ll);
    if (live && !map.getBounds().pad(-0.1).contains(ll)) map.panTo(ll);
    $('gps-meta').textContent = `${r.gps.lat.toFixed(5)}, ${r.gps.lon.toFixed(5)}`;
  }

  function rebuildMap() {
    const gpsRecords = records.filter((r) => r.gps).slice(-500);
    if (!gpsRecords.length) return;
    if (map) { track.setLatLngs([]); points.clearLayers(); markers = []; }
    gpsRecords.forEach((r) => addGps(r, false));
    map.invalidateSize();
    if (gpsRecords.length > 1) map.fitBounds(track.getBounds(), { padding: [30, 30], maxZoom: 18 });
    recolorMap();
  }

  function rampColor(t) {
    const pos = Math.min(Math.max(t, 0), 1) * (RAMP.length - 1);
    const i = Math.min(Math.floor(pos), RAMP.length - 2);
    const mix = (a, b) => Math.round(a + (b - a) * (pos - i));
    const [c1, c2] = [RAMP[i], RAMP[i + 1]].map((h) => [1, 3, 5].map((j) => parseInt(h.slice(j, j + 2), 16)));
    return `rgb(${c1.map((v, j) => mix(v, c2[j])).join(',')})`;
  }

  // Colour every GPS point by the selected reading so field zones can be compared.
  function recolorMap() {
    if (!map) return;
    if (markers.length > 500) {
      markers.splice(0, markers.length - 500).forEach((m) => points.removeLayer(m.marker));
      track.setLatLngs(markers.map((m) => m.marker.getLatLng()));
    }
    const key = $('chart-key').value;
    const values = markers.map((m) => m.r.readings[key]?.value).filter((v) => v !== undefined);
    const min = Math.min(...values), max = Math.max(...values);
    for (const { marker, r } of markers) {
      const v = r.readings[key]?.value;
      marker.setStyle({ fillColor: v === undefined ? '#9aa294' : rampColor((v - min) / (max - min || 1)) });
    }
    $('legend').hidden = !values.length;
    if (!values.length) return;
    const fmt = (v) => (isBinary(key) ? stateText(key, v) : `${format(v)} ${meta(key).unit || ''}`.trim());
    $('legend-min').textContent = fmt(min);
    $('legend-max').textContent = fmt(max);
  }

  // ---------- status ----------
  function sourceState() {
    const now = serverNow();
    const lastT = source === 'blynk' ? (status?.blynk.lastUpdate ?? last()?.t) : (status?.local.lastUpdate ?? last()?.t);
    const since = lastT ? `Last update ${ago(now - lastT)}` : 'No data received yet';
    if (!streamOk) return { cls: 'offline', text: 'Server unreachable', note: 'Connection to the AgriFly server lost. Retrying...' };
    if (source === 'local') {
      if (!lastT) return { cls: '', text: 'Waiting for device', note: since, empty: 'No readings yet. Set LOCAL_URL in the ESP32 sketch to this server, or run npm run simulate on the laptop to send test data.' };
      if (now - lastT > LOCAL_OFFLINE_MS) return { cls: 'offline', text: 'Device offline', note: since };
      return { cls: 'live', text: 'Live', note: since };
    }
    const b = status?.blynk;
    if (!b) return { cls: '', text: 'Checking...', note: since };
    if (!b.configured) return { cls: 'offline', text: 'Blynk not set up', note: 'No Blynk token on the server.', empty: 'Blynk Cloud is not set up yet. Add your Blynk device token to .env as BLYNK_TOKEN and restart the server.' };
    if (b.lastError) return { cls: 'offline', text: 'Blynk error', note: b.lastError };
    if (b.deviceOnline === false) return { cls: 'offline', text: 'Device offline', note: `Blynk says the ESP32 is not connected. ${since}`, empty: 'The ESP32 is not connected to Blynk. Check that it is powered and on 2.4 GHz Wi-Fi.' };
    if (b.deviceOnline === true && lastT) return { cls: 'live', text: 'Live', note: since };
    return { cls: '', text: 'Waiting for device', note: since, empty: 'Waiting for the first reading from Blynk.' };
  }

  function tick() {
    const s = sourceState();
    $('status').className = `status ${s.cls}`.trim();
    $('status').textContent = s.text;
    $('meta').textContent = s.note;
    const hasData = records.length > 0;
    $('empty').hidden = hasData || !s.empty;
    $('empty').textContent = s.empty || '';
    $('view').hidden = !hasData;
    const now = serverNow();
    for (const [key, c] of cards) {
      if (!c.lastT) continue;
      c.ago.textContent = `updated ${ago(now - c.lastT)}`;
      c.el.classList.toggle('stale', s.cls !== 'live' || now - c.lastT > 30000); // e.g. a sensor that stopped reporting
      if (c.binary) {
        const n = detections(key);
        c.detections.textContent = `${n} detection${n === 1 ? '' : 's'} in the last 10 min`;
      }
    }
  }

  function rebuild() {
    for (const r of records) Object.keys(r.readings).forEach(ensureCard);
    for (const key of cards.keys()) updateCard(key);
    syncChartOptions();
    updateChart();
    rebuildMap();
    tick();
  }

  // ---------- wiring ----------
  $('chart-key').addEventListener('change', () => select($('chart-key').value));
  $('chart-range').addEventListener('change', updateChart);
  for (const b of document.querySelectorAll('[data-source]')) b.addEventListener('click', () => { if (b.dataset.source !== source) setSource(b.dataset.source); });
  setInterval(tick, 1000);
  setInterval(refreshStatus, 3000);
  setInterval(updateChart, 15000); // slide the time window even when no data arrives
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { for (const key of cards.keys()) updateCard(key); }, 150);
  });

  (async () => {
    try { sensors = await (await fetch('/api/sensors')).json(); } catch { sensors = []; }
    let saved = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* storage blocked */ }
    setSource(saved === 'local' ? 'local' : 'blynk');
  })();
})();
