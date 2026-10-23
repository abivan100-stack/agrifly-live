// Live dashboard. Everything is generated from the reading keys the device sends,
// so a new sensor in the firmware shows up here with no code change.
(() => {
  const { prettify, format, ago } = window.AgriFly;
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const DEFAULT_INTERVAL_MS = 2000;
  const SPARK_POINTS = 40;
  // map points: low -> high value of the selected reading
  const RAMP = ['#f0e7a1', '#c6d36a', '#7fae4f', '#3c7a3a', '#1c4a2a'];

  let records = [];        // sorted by server time t
  let clockOffset = 0;     // server clock - this device's clock
  const cards = new Map(); // key -> { el, value, unit, spark, ago }
  let chart = null;
  let map = null, track = null, points = null, lastMarker = null;
  let markers = [];        // { marker, r } for value colouring
  let streamOk = true;

  const serverNow = () => Date.now() + clockOffset;
  const last = () => records.at(-1);

  // ---------- data loading ----------
  async function loadHistory() {
    const data = await (await fetch('/api/history?limit=2000', { cache: 'no-store' })).json();
    clockOffset = data.now - Date.now();
    const newestLoaded = data.readings.at(-1)?.t ?? 0;
    // keep anything the stream delivered while the request was in flight
    records = data.readings.concat(records.filter((r) => r.t > newestLoaded));
    rebuild();
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
    for (const k of cards.keys()) updateCard(k); // redraw sparklines in the new card colours
  }

  // ---------- cards ----------
  function ensureCard(key) {
    if (cards.has(key)) return;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'card';
    el.innerHTML = '<div class="label"></div><div class="value"><span></span><small></small></div><canvas></canvas><div class="ago"></div>';
    el.querySelector('.label').textContent = prettify(key);
    el.addEventListener('click', () => select(key));
    const keys = [...cards.keys(), key].sort();
    const before = cards.get(keys[keys.indexOf(key) + 1]);
    $('cards').insertBefore(el, before ? before.el : null);
    cards.set(key, {
      el,
      value: el.querySelector('.value span'),
      unit: el.querySelector('.value small'),
      spark: el.querySelector('canvas'),
      ago: el.querySelector('.ago'),
      lastT: 0,
    });
    $('empty').hidden = true;
    $('view').hidden = false;
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
    c.value.textContent = format(latest.value);
    c.unit.textContent = latest.unit;
    c.lastT = latest.t;
    drawSpark(c.spark, series.reverse());
  }

  function drawSpark(canvas, values) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    if (values.length < 2) return;
    const min = Math.min(...values), max = Math.max(...values);
    const span = max - min || 1;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = (i / (values.length - 1)) * (w - 2) + 1;
      const y = h - 3 - ((v - min) / span) * (h - 6);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = getComputedStyle(canvas).color; // follows the card, so it inverts when selected
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // ---------- main chart ----------
  function syncChartOptions() {
    const sel = $('chart-key');
    const have = new Set([...sel.options].map((o) => o.value));
    for (const key of [...cards.keys()].sort()) {
      if (have.has(key)) continue;
      sel.add(new Option(prettify(key), key, false, key === 'temperature'));
    }
    // keep the dropdown alphabetical like the cards
    const sorted = [...sel.options].sort((a, b) => a.value.localeCompare(b.value));
    const current = sel.value;
    if (sorted.some((o, i) => o !== sel.options[i])) { sorted.forEach((o) => sel.add(o)); sel.value = current; }
  }

  function updateChart() {
    const key = $('chart-key').value;
    if (!key || typeof Chart === 'undefined') return;
    for (const [k, c] of cards) c.el.setAttribute('aria-pressed', String(k === key));
    const range = Number($('chart-range').value);
    const from = range ? serverNow() - range : 0;
    const data = [];
    let unit = '';
    for (const r of records) {
      const rd = r.readings[key];
      if (r.t < from || !rd) continue;
      data.push({ x: r.t, y: rd.value });
      unit = rd.unit;
    }
    if (!chart) chart = makeChart();
    chart.data.datasets[0].data = data;
    chart.data.datasets[0].label = `${prettify(key)}${unit ? ` (${unit})` : ''}`;
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
      data: { datasets: [{ data: [], borderColor: green, backgroundColor: green + '22', fill: true, pointRadius: 0, borderWidth: 2, cubicInterpolationMode: 'monotone' }] },
      options: {
        animation: false,
        maintainAspectRatio: false,
        parsing: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { display: false }, // the dropdown already names the series
          tooltip: { callbacks: { title: (items) => new Date(items[0].parsed.x).toLocaleTimeString() } },
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
    const summary = Object.entries(r.readings).map(([k, v]) => `${prettify(k)}: ${format(v.value)} ${v.unit}`).join('<br>');
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
    const unit = markers.findLast((m) => m.r.readings[key])?.r.readings[key].unit || '';
    $('legend-min').textContent = `${format(min)} ${unit}`.trim();
    $('legend-max').textContent = `${format(max)} ${unit}`.trim();
  }

  // ---------- status ----------
  function expectedInterval() {
    const recent = records.slice(-11);
    if (recent.length < 3) return DEFAULT_INTERVAL_MS;
    const gaps = recent.slice(1).map((r, i) => r.t - recent[i].t).sort((a, b) => a - b);
    return Math.min(Math.max(gaps[Math.floor(gaps.length / 2)], 1000), 60000);
  }

  function tick() {
    const pill = $('status');
    const r = last();
    const now = serverNow();
    if (!r) {
      pill.className = 'status';
      pill.textContent = 'Waiting for device';
    } else if (now - r.t <= 3 * expectedInterval()) {
      pill.className = 'status live';
      pill.textContent = 'Live';
    } else {
      pill.className = 'status offline';
      pill.textContent = `Offline — last data ${ago(now - r.t)}`;
    }
    $('meta').textContent = !streamOk
      ? 'Connection to server lost — retrying...'
      : r ? `Device ${r.device}, ${records.length} readings loaded` : 'No data received yet';
    for (const c of cards.values()) {
      if (!c.lastT) continue;
      c.ago.textContent = `updated ${ago(now - c.lastT)}`;
      c.el.classList.toggle('stale', now - c.lastT > 3 * expectedInterval());
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
  setInterval(tick, 1000);
  setInterval(updateChart, 15000); // slide the time window even when no data arrives
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { for (const key of cards.keys()) updateCard(key); }, 150);
  });

  // SSE reconnects by itself; each (re)connect re-syncs history so no gap is left behind.
  const es = new EventSource('/api/stream');
  es.onopen = () => { streamOk = true; loadHistory().catch((e) => console.error('history load failed', e)); };
  es.onmessage = (e) => onRecord(JSON.parse(e.data));
  es.onerror = () => { streamOk = false; tick(); };
})();
