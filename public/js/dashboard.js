// Live dashboard. Cards come from config/sensors.json (via /api/sensors); any other key that arrives
// from the local source gets a card too, so a new sensor needs no code change here.
// Two sources: Blynk Cloud (default) and Local Wi-Fi, switched with the toggle at the top.
// /api/config says how this copy runs: locally (npm start) data comes over SSE; on Vercel the page polls
// /api/latest, keeps history in memory, builds the CSV itself, and Local Wi-Fi is switched off.
(() => {
  const { prettify, format, ago, duration } = window.AgriFly;
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const LOCAL_OFFLINE_MS = 10000;
  const SPARK_POINTS = 40;
  const DETECTION_WINDOW_MS = 10 * 60000;
  const RAMP = ['#e6f2dd', '#b1d3b9', '#88bda4', '#659287', '#3e6a60']; // map points: low -> high (team palette)
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
  let selectedKey = null;    // the reading shown large in the focus panel, on the chart and on the map
  let range = 900000;        // chart window in ms, 0 = all
  let cloud = false;         // true on Vercel: poll instead of SSE, Blynk only
  let pollMs = 3000;
  let pollTimer = null;
  const LOCAL_ONLY = 'Available only when running on the same network (npm start)';
  const GAP_MS = 20000;      // readings further apart than this: no data in between (tab closed, device offline)
  const HISTORY_KEY = 'agrifly-history-blynk'; // Vercel keeps no history, so each browser keeps its own

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
    if (cloud) { records = loadSaved(); rebuild(); }
    connect();
    refreshStatus();
  }

  function reset() {
    records = [];
    for (const c of cards.values()) c.el.remove();
    cards.clear();
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
    if (cloud) return startPolling();
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

  // ---------- Vercel: poll Blynk through /api/latest (cached 3 s on the CDN), only while the tab is visible ----------
  function startPolling() {
    clearTimeout(pollTimer);
    const run = async () => {
      if (document.visibilityState === 'visible') await pollCloud();
      pollTimer = setTimeout(run, pollMs);
    };
    run();
  }

  async function pollCloud() {
    try {
      const res = await fetch('/api/latest?source=blynk');
      const data = await res.json();
      streamOk = true;
      status = { blynk: {
        configured: data.configured !== false,
        deviceOnline: data.deviceOnline ?? null,
        lastUpdate: data.latest?.t ?? null,
        lastError: res.ok ? null : data.error,
      } };
      if (data.latest) onRecord(data.latest); // repeats of a cached response have the same t and are skipped
    } catch {
      streamOk = false;
    }
    tick();
  }

  // browser-side history for Vercel, so a reload doesn't start from an empty chart
  function loadSaved() {
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(saved) ? saved.filter((r) => r && typeof r.t === 'number' && r.readings).sort((a, b) => a.t - b.t) : [];
    } catch { return []; }
  }
  function saveNow() {
    if (!cloud) return;
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(records.slice(-2000))); } catch { /* storage full or blocked */ }
  }
  let saveTimer = null;
  function saveSoon() {
    if (!cloud || saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 10000);
  }

  function downloadCsv() {
    const keys = [...new Set(records.flatMap((r) => Object.keys(r.readings)))];
    const unit = (k) => records.findLast((r) => r.readings[k])?.readings[k].unit || '';
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const header = ['time', 'source', 'device', 'lat', 'lon', ...keys.map((k) => (unit(k) ? `${k} (${unit(k)})` : k))];
    const rows = records.map((r) => [new Date(r.t).toISOString(), r.source, r.device, r.gps?.lat ?? '', r.gps?.lon ?? '',
      ...keys.map((k) => r.readings[k]?.value ?? '')]);
    const blob = new Blob(['﻿' + [header, ...rows].map((row) => row.map(esc).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `agrifly-${source}-readings.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function refreshStatus() {
    if (cloud) return; // status comes with each /api/latest poll
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
    if (records.length > 2200) records = records.slice(-2000);
    saveSoon();
    Object.keys(r.readings).forEach(ensureCard);
    for (const key of Object.keys(r.readings)) updateCard(key);
    syncChartOptions();
    updateChart();
    if (r.gps) { addGps(r, true); recolorMap(); }
    tick();
  }

  // One selection drives the cards, the chart and the map colours.
  function select(key) {
    selectedKey = key;
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
      ? '<span class="label"></span><span class="state off">No data yet</span><canvas aria-hidden="true"></canvas><span class="detections"></span><span class="ago"></span>'
      : '<span class="label"></span><span class="value"><span>--</span><small></small></span><canvas aria-hidden="true"></canvas><span class="ago">No data yet</span>';
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

  // detections that started in the last 10 minutes (same runs as the list and the chart)
  function detections(key) {
    const from = serverNow() - DETECTION_WINDOW_MS;
    return runsOf(key).filter((r) => r.start >= from).length;
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
  // keep the selection valid: first reading in the list unless one was picked
  function syncChartOptions() {
    if (!cards.has(selectedKey)) selectedKey = cards.keys().next().value ?? null;
  }

  // on-runs of a binary sensor, oldest first: { start, end } (end null = still on)
  // a gap in the data ends a run at the last reading before it
  function runsOf(key) {
    const runs = [];
    let open = null, prevT = null;
    for (const r of records) {
      const rd = r.readings[key];
      if (!rd) continue;
      if (open && r.t - prevT > GAP_MS) { open.end = prevT; open = null; }
      if (rd.value && !open) runs.push(open = { start: r.t, end: null });
      else if (!rd.value && open) { open.end = r.t; open = null; }
      prevT = r.t;
    }
    return runs;
  }

  // when the current state began; observed = we saw it change (otherwise it began before our data)
  function stateSince(key) {
    let cur = null, since = null;
    for (let i = records.length - 1; i >= 0; i--) {
      const rd = records[i].readings[key];
      if (!rd) continue;
      const v = Boolean(rd.value);
      if (cur === null) cur = v;
      if (since !== null && since - records[i].t > GAP_MS) return { since, observed: false };
      if (v !== cur) return { since, observed: true };
      since = records[i].t;
    }
    return { since, observed: false };
  }

  function renderEvents(key, runs, now) {
    const list = runs.slice(-8).reverse().map((run) => {
      const li = document.createElement('li');
      if (run.end === null) li.className = 'now';
      const time = Object.assign(document.createElement('time'), {
        dateTime: new Date(run.start).toISOString(),
        textContent: new Date(run.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      });
      const held = document.createElement('span');
      const ms = (run.end ?? now) - run.start;
      held.textContent = run.end === null ? `${duration(ms)} so far` : ms < 1000 ? 'brief' : duration(ms);
      li.append(time, held);
      return li;
    });
    if (!list.length) list.push(Object.assign(document.createElement('li'), { className: 'none', textContent: `No ${stateText(key, 1).toLowerCase()} yet.` }));
    $('events').replaceChildren(...list);
  }

  // the focus panel: selected reading, large. On/off sensors get the live banner.
  let shownState = null;
  function updateFocus() {
    const key = selectedKey;
    const value = $('focus-value');
    if (!key) return;
    const binary = isBinary(key);
    $('focus').classList.toggle('binary', binary);
    $('events-box').hidden = !binary;
    $('focus-label').textContent = meta(key).label;
    const r = records.findLast((x) => x.readings[key]);
    value.className = 'focus-value';
    if (!r) {
      value.textContent = '--';
      $('focus-sub').textContent = 'No data yet';
      $('focus').classList.remove('is-on');
      if (binary) renderEvents(key, [], 0);
      return;
    }
    const v = r.readings[key].value;
    const now = serverNow();
    const age = `updated ${ago(now - r.t)}`;
    if (binary) {
      const on = Boolean(v);
      const runs = runsOf(key);
      const { since, observed } = stateSince(key);
      const dot = Object.assign(document.createElement('i'), { className: 'dot' });
      dot.setAttribute('aria-hidden', 'true');
      value.replaceChildren(dot, stateText(key, on));
      const n = detections(key);
      const focus = $('focus');
      $('focus-sub').textContent = focus.classList.contains('stale')
        ? `Last known state, ${age}. Not live right now.`
        : `For ${observed ? '' : 'at least '}${duration(now - since)}. ${n} detection${n === 1 ? '' : 's'} in the last 10 min, ${age}.`;
      focus.classList.toggle('is-on', on);
      const state = `${key}:${on}`;
      if (shownState && shownState !== state) { focus.classList.remove('flip'); void focus.offsetWidth; focus.classList.add('flip'); }
      shownState = state;
      renderEvents(key, runs, now);
    } else {
      const unit = Object.assign(document.createElement('small'), { textContent: r.readings[key].unit || meta(key).unit || '' });
      value.replaceChildren(format(v), unit);
      $('focus-sub').textContent = age[0].toUpperCase() + age.slice(1);
    }
  }

  // On/off sensors: a strip of when it was on, plus detections per minute as bars.
  // Number sensors: one clean line, with low / average / high for the chosen range.
  let chartKind = null;
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: chart.$bucket < 60000 ? '2-digit' : undefined });

  function updateChart() {
    const key = selectedKey;
    for (const [k, c] of cards) c.el.setAttribute('aria-pressed', String(k === key));
    updateFocus();
    if (!key || typeof Chart === 'undefined') return;
    const binary = isBinary(key);
    const now = serverNow();
    const from = range ? now - range : 0;
    const pts = [];
    let seed = null; // last value before the range, so the strip knows the starting state
    for (const r of records) {
      const rd = r.readings[key];
      if (!rd) continue;
      const p = { x: r.t, y: binary ? (rd.value ? 1 : 0) : rd.value };
      if (r.t < from) seed = p; else pts.push(p);
    }
    const kind = binary ? 'bar' : 'line';
    if (chartKind !== kind) { chart?.destroy(); chart = makeChart(kind); chartKind = kind; }
    $('strip-box').hidden = !binary;
    $('chart-title').hidden = !binary;
    if (!pts.length) { renderStats([]); chart.data.datasets[0].data = []; chart.update('none'); return; }
    // don't stretch a few minutes of data across an empty 15 min / 1 h axis
    const start = pts[0].x;
    const x = chart.options.scales.x;
    if (binary) {
      const end = Math.max(now, pts.at(-1).x);
      // buckets end exactly at "now", so the newest bar and the strip both finish at the right edge
      const size = bucketSize(end - start);
      const n = Math.max(1, Math.ceil((end - start) / size));
      const first = end - n * size;
      const counts = Array.from({ length: n }, (_, i) => ({ x: first + (i + 0.5) * size, y: 0 }));
      const hits = runsOf(key).filter((r) => r.start >= from);
      for (const r of hits) counts[Math.min(n - 1, Math.floor((r.start - first) / size))].y++;
      const edges = hits.length, lastHit = hits.at(-1)?.start ?? null;
      let onMs = 0, covered = 0;
      pts.forEach((p, i) => {
        const step = (pts[i + 1]?.x ?? end) - p.x;
        if (step <= GAP_MS) { covered += step; if (p.y === 1) onMs += step; } // gaps count as unknown, not as clear
      });
      chart.data.datasets[0].data = counts;
      chart.$bucket = size;
      x.min = first; x.max = end;
      $('chart-title').textContent = `Detections per ${bucketName(size)}`;
      $('strip-title').textContent = stateText(key, 1);
      $('chart-empty').hidden = edges > 0;
      chart.update('none');
      drawStrip(pts, seed, x.min, x.max, end);
      renderStats([
        ['Detections', String(edges)],
        ['Time detected', covered ? `${Math.round((onMs / covered) * 100)}%` : '--'],
        ['Last detection', lastHit ? ago(now - lastHit) : 'None in range'],
      ]);
    } else {
      $('chart-empty').hidden = true;
      chart.data.datasets[0].data = pts;
      x.min = start; x.max = pts.at(-1).x;
      chart.update('none');
      const ys = pts.map((p) => p.y);
      const unit = meta(key).unit || records.findLast((r) => r.readings[key])?.readings[key].unit || '';
      const f = (v) => `${format(v)} ${unit}`.trim();
      renderStats([['Low', f(Math.min(...ys))], ['Average', f(ys.reduce((a, b) => a + b, 0) / ys.length)], ['High', f(Math.max(...ys))]]);
    }
  }

  // bar width: the smallest step that keeps the chart under ~30 bars
  function bucketSize(span) {
    const steps = [10, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);
    return steps.find((s) => span / s <= 30) ?? 3600000;
  }
  const bucketName = (size) => (size < 60000 ? `${size / 1000} seconds`
    : size === 60000 ? 'minute' : size === 3600000 ? 'hour' : `${size / 60000} minutes`);

  function renderStats(items) {
    $('stats').replaceChildren(...items.map(([k, v]) => {
      const d = document.createElement('div');
      d.append(Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v }));
      return d;
    }));
  }

  // lined up with the bar chart's plot area so both share one time axis
  function drawStrip(pts, seed, min, max, end) {
    const canvas = $('strip');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const { left, right } = chart.chartArea;
    const sx = (t) => left + ((Math.max(t, min) - min) / (max - min || 1)) * (right - left);
    const block = (from, to) => { const a = sx(from); ctx.fillRect(a, 0, Math.max(2, sx(to) - a), h); };
    // light track only where there is data; blank where the tab was closed or the device was offline
    ctx.fillStyle = css('--rule');
    let segStart = seed && pts[0].x - seed.x <= GAP_MS ? min : pts[0].x;
    pts.forEach((p, i) => {
      const next = pts[i + 1]?.x ?? end;
      if (next - p.x > GAP_MS) { block(segStart, p.x + 1000); segStart = pts[i + 1]?.x; }
    });
    if (segStart !== undefined && end - pts.at(-1).x <= GAP_MS) block(segStart, end);
    // one solid block per "on" run, ended by an off reading or by a gap
    ctx.fillStyle = css('--field-strong');
    let runStart = seed?.y === 1 && pts[0].x - seed.x <= GAP_MS ? min : null, prevX = null;
    for (const p of pts) {
      if (runStart !== null && prevX !== null && p.x - prevX > GAP_MS) { block(runStart, prevX); runStart = null; }
      if (p.y === 1 && runStart === null) runStart = p.x;
      if (p.y === 0 && runStart !== null) { block(runStart, p.x); runStart = null; }
      prevX = p.x;
    }
    if (runStart !== null) block(runStart, end - prevX > GAP_MS ? prevX : end);
  }

  function makeChart(kind) {
    const text = css('--muted'), grid = css('--rule'), green = css('--field'), strong = css('--field-strong');
    Chart.defaults.font.family = css('--body');
    Chart.defaults.font.size = 12;
    const bar = kind === 'bar';
    return new Chart($('chart'), {
      type: kind,
      data: { datasets: [bar
        ? { data: [], backgroundColor: green, hoverBackgroundColor: strong, borderRadius: 2, barPercentage: 1, categoryPercentage: 0.72 }
        : { data: [], borderColor: green, borderWidth: 2, fill: false, cubicInterpolationMode: 'monotone',
            pointRadius: (c) => (c.dataIndex === c.dataset.data.length - 1 ? 4 : 0), pointBackgroundColor: green,
            pointHoverRadius: 5, pointHoverBackgroundColor: strong }] },
      options: {
        animation: false,
        maintainAspectRatio: false,
        parsing: false,
        interaction: bar ? { mode: 'nearest', axis: 'x', intersect: true } : { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { display: false }, // the focus panel already names the reading
          tooltip: {
            backgroundColor: css('--station'), padding: 10, displayColors: false, cornerRadius: 4,
            callbacks: {
              title: (items) => {
                const t = items[0].parsed.x;
                return bar ? `${clock(t - chart.$bucket / 2)} to ${clock(t + chart.$bucket / 2)}` : new Date(t).toLocaleTimeString();
              },
              label: (item) => (bar
                ? `${item.parsed.y} detection${item.parsed.y === 1 ? '' : 's'}`
                : `${format(item.parsed.y)} ${meta(selectedKey).unit || ''}`.trim()),
            },
          },
        },
        scales: {
          x: { type: 'linear', offset: false, grid: { display: false }, border: { color: grid },
            ticks: { color: text, maxTicksLimit: innerWidth < 600 ? 3 : 7, maxRotation: 0, callback(v) {
              const short = this.max - this.min < 10 * 60000; // show seconds on short spans
              return new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: short ? '2-digit' : undefined });
            } } },
          y: { beginAtZero: bar, suggestedMax: bar ? 3 : undefined, border: { display: false },
            grid: { color: grid }, ticks: { color: text, precision: bar ? 0 : undefined, maxTicksLimit: 5, callback: (v) => format(v) } },
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
      track = L.polyline([], { color: '#659287', weight: 2, opacity: 0.6 }).addTo(map);
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
    const key = selectedKey;
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
    // newest of the status poll and the stream, so "Xs ago" doesn't lag behind the cards
    const lastT = Math.max(status?.[source]?.lastUpdate ?? 0, last()?.t ?? 0) || null;
    const since = lastT ? `Last update ${ago(now - lastT)}` : 'No data received yet';
    if (!streamOk) return { cls: 'offline', text: 'Server unreachable', note: 'Connection to the AgriFly server lost. Retrying...' };
    if (source === 'local') {
      const l = status?.local;
      const FROM = { env: 'from ESP_HOST', blynk: 'from Blynk', mdns: 'via mDNS' };
      const where = l?.host ? `${l.host} · ${FROM[l.hostSource] || ''}` : 'Looking for the ESP32...';
      const unreachable = 'ESP32 not reachable on this network — make sure this laptop and the ESP32 are on the same Wi-Fi.';
      if (l?.reachable === false) return { cls: 'offline', text: 'Not reachable', note: `${where}. ${l.lastError || ''}`.trim(), empty: unreachable, alert: unreachable };
      if (!lastT) return { cls: '', text: 'Waiting for device', note: where, empty: 'Asking the ESP32 for its first reading...' };
      if (now - lastT > LOCAL_OFFLINE_MS) return { cls: 'offline', text: 'Device offline', note: `${where}. ${since}` };
      return { cls: 'live', text: 'Live', note: `${where}. ${since}` };
    }
    const b = status?.blynk;
    if (!b) return { cls: '', text: 'Checking...', note: since };
    if (!b.configured) return { cls: 'offline', text: 'Blynk not set up', note: 'No Blynk token on the server.', empty: cloud
      ? 'Blynk Cloud is not set up yet. Add BLYNK_TOKEN in Vercel (Settings, Environment Variables) and redeploy.'
      : 'Blynk Cloud is not set up yet. Add your Blynk device token to .env as BLYNK_TOKEN and restart the server.' };
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
    // an unreachable ESP32 is shown even when older readings are on screen
    $('empty').hidden = !(s.alert || (!hasData && s.empty));
    $('empty').textContent = s.alert || s.empty || '';
    $('focus').classList.toggle('stale', s.cls !== 'live'); // banner greys out: last known state, not live
    updateFocus();
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
  for (const b of document.querySelectorAll('[data-range]')) {
    b.addEventListener('click', () => {
      range = Number(b.dataset.range);
      for (const o of document.querySelectorAll('[data-range]')) o.setAttribute('aria-pressed', String(o === b));
      updateChart();
    });
  }
  for (const b of document.querySelectorAll('[data-source]')) b.addEventListener('click', () => { if (b.dataset.source !== source) setSource(b.dataset.source); });
  setInterval(tick, 1000);
  setInterval(refreshStatus, 3000);
  setInterval(updateChart, 5000); // slide the time window even when no data arrives
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { for (const key of cards.keys()) updateCard(key); updateChart(); }, 150);
  });

  $('csv').addEventListener('click', (e) => { if (cloud) { e.preventDefault(); downloadCsv(); } });
  document.addEventListener('visibilitychange', () => { if (cloud && document.visibilityState === 'visible') startPolling(); });
  window.addEventListener('pagehide', saveNow);

  (async () => {
    try { sensors = await (await fetch('/api/sensors')).json(); } catch { sensors = []; }
    try {
      const config = await (await fetch('/api/config')).json();
      cloud = config.deployment === 'vercel';
      pollMs = config.pollMs || 3000;
    } catch { /* older server: behave as local */ }
    if (cloud) {
      const btn = document.querySelector('[data-source="local"]');
      btn.disabled = true;
      btn.title = LOCAL_ONLY;
      $('local-note').hidden = false;
    }
    let saved = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* storage blocked */ }
    setSource(!cloud && saved === 'local' ? 'local' : 'blynk');
  })();
})();
