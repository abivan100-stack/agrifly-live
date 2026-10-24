// Drone camera view of a crop field, drawn pixel by pixel.
// For each pixel a ray goes from the camera to the ground plane (like a flight sim's "mode 7"), so height,
// turning, pitch and bank all change the picture the way a real FPV camera would.
// World: x = east, y = north, z = up, in metres. Fields of crop rows 0.75 m apart (north-south or east-west),
// separated by farm tracks, with tramlines, a tree line, drifting cloud shadows and haze.
//
// This file runs in two places: on the page (createView: sizing, scheduling, drawing to the canvas) and inside
// js/field-worker.js (createRenderer: the per-pixel work), so several CPU cores can each draw a band of rows.
// The per-pixel code avoids Math.hypot, array loops and sine-based noise on purpose: it runs for every pixel.
(function (root) {
  const ROW_M = 0.75;                     // row spacing
  const FIELD_W = 140, FIELD_H = 220;     // one field, between farm tracks
  const TRACK = 5;                        // farm track width
  const TRAM = 24;                        // tractor tramlines every 24 m, two wheel ruts 1.8 m apart
  const TREES_AT = 700;                   // the tree line around the farm, metres away
  const FOV_H = 95 * Math.PI / 180;       // wide FPV lens

  const fract = (v) => v - Math.floor(v);
  // fast integer hash -> 0..1
  const hash = (x, y) => {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (a, b, v) => { let t = (v - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
  const byte = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : v | 0);
  const rgb = (r, g, b) => 0xff000000 | (byte(b) << 16) | (byte(g) << 8) | byte(r); // canvas pixels are ABGR

  // colours
  const LW = [64, 104, 52], LD = [146, 140, 82];       // leaf: well watered / dry
  const SW = [78, 64, 50], SD = [134, 116, 92];        // soil: wet / dry
  const TR = [178, 160, 124], RU = [146, 127, 97];     // farm track, its ruts
  const HZ = [206, 215, 207];                          // haze
  const SL = [214, 224, 221], SH = [124, 161, 184];    // sky near the horizon, sky overhead
  const TE = [76, 99, 72];                             // tree line

  // Soil moisture (% est.) across the simulated farm: smooth wet and dry zones.
  // The demo readings, the minimap and the camera view all use this one function.
  function soilAt(x, y) {
    const m = 46 + 24 * Math.sin(x / 70 + 0.6) * Math.cos(y / 120) + 12 * Math.sin((x + y) / 45) + 6 * Math.cos(y / 33);
    return Math.min(95, Math.max(5, m));
  }

  // A smooth world-space pattern, precomputed on a grid around the camera and blended (bilinear).
  // Soil zones and cloud shadows change over tens of metres, so an 8 m grid looks the same as computing
  // them per pixel, at a fraction of the cost. When the camera wanders far from the grid's centre, a new grid is
  // built a few rows per frame in the background and swapped in when complete, so flying never stutters.
  function gridField(fn, cell = 8, n = 256, rowsPerFrame = 16) {
    const half = (n * cell) / 2;
    let cur = null, next = null;
    const start = (cx, cy) => ({
      data: new Float32Array(n * n), row: 0,
      ox: Math.floor(cx / cell - n / 2) * cell, oy: Math.floor(cy / cell - n / 2) * cell,
    });
    const build = (g, rows) => {
      for (const end = Math.min(n, g.row + rows); g.row < end; g.row++) {
        for (let i = 0, k = g.row * n; i < n; i++, k++) g.data[k] = fn(g.ox + i * cell, g.oy + g.row * cell);
      }
      return g.row === n;
    };
    function ensure(cx, cy) {
      if (!cur) { cur = start(cx, cy); build(cur, n); return; }            // first frame: build it all at once
      if (next) { if (build(next, rowsPerFrame)) { cur = next; next = null; } return; }
      if (Math.abs(cx - (cur.ox + half)) > half * 0.4 || Math.abs(cy - (cur.oy + half)) > half * 0.4) next = start(cx, cy);
    }
    function at(x, y) {
      const fx = (x - cur.ox) / cell, fy = (y - cur.oy) / cell;
      if (fx < 0 || fy < 0 || fx >= n - 1 || fy >= n - 1) return fn(x, y); // beyond the grid: rare, far and fogged
      const i = fx | 0, j = fy | 0, tx = fx - i, ty = fy - j, k = j * n + i, d = cur.data;
      const a = d[k] + (d[k + 1] - d[k]) * tx, b = d[k + n] + (d[k + n + 1] - d[k + n]) * tx;
      return a + (b - a) * ty;
    }
    return { ensure, at };
  }

  // cloud shadow strength 0..1 (the pattern drifts with the wind; see renderRows)
  const cloudAt = (x, y) => smooth(0.35, 0.8, 0.5 + 0.5 * Math.sin(x / 95) * Math.sin(y / 130));
  const WIND_X = 0.9, WIND_Y = 0.6;     // m/s, how fast the cloud shadows drift

  // The per-pixel renderer. Works on any rows of a W x H picture, so the picture can be split into bands.
  function createRenderer() {
    const soilGrid = gridField((x, y) => soilAt(x, y) / 100);
    const cloudGrid = gridField(cloudAt);

    // sky, or the tree line along the horizon; e = sine of the elevation angle, pe = how much e one pixel spans
    function sky(dx, dy, e, pe) {
      const g = smooth(0, 0.5, e);
      const sr = SL[0] + (SH[0] - SL[0]) * g, sg = SL[1] + (SH[1] - SL[1]) * g, sb = SL[2] + (SH[2] - SL[2]) * g;
      if (e < 0.03) {
        const az = Math.atan2(dx, dy);
        const top = 0.0115 + 0.003 * Math.sin(az * 5 + 1.3) + 0.002 * Math.sin(az * 13 + 0.4)
          + 0.0012 * Math.sin(az * 37 + 2) + 0.0008 * Math.sin(az * 71 + 0.7) + 0.0005 * Math.sin(az * 149);
        // how much of this pixel is tree: blended across one pixel so the top edge isn't jagged
        const amt = Math.min(1, Math.max(0, (top - e) / pe + 0.5));
        if (amt > 0) {
          const v = (0.93 + 0.09 * Math.sin(az * 211) * Math.sin(az * 97)) * 0.45; // far away, so half hidden by haze
          const tr = TE[0] * v + HZ[0] * 0.55, tg = TE[1] * v + HZ[1] * 0.55, tb = TE[2] * v + HZ[2] * 0.55;
          return rgb(sr + (tr - sr) * amt, sg + (tg - sg) * amt, sb + (tb - sb) * amt);
        }
      }
      return rgb(sr, sg, sb);
    }

    // the ground at (gx, gy); wx / wy = metres one pixel covers across / along the rows (for anti-aliasing)
    function ground(gx, gy, wx, wy, dist, time) {
      const m = soilGrid.at(gx, gy);                            // soil moisture 0..1, the field the demo readings use
      const fx = Math.floor(gx / FIELD_W), fy = Math.floor(gy / FIELD_H);
      const lx = gx - fx * FIELD_W, ly = gy - fy * FIELD_H;
      const crop = hash(fx, fy);                                // each field is at a slightly different growth stage

      // most fields are sown north-south, some east-west (rows change direction at the field edge)
      const ew = hash(fx + 17, fy + 31) > 0.62;
      const across = ew ? gy : gx, along = ew ? gx : gy;    // position across / along the rows
      const wA = ew ? wy : wx, wL = ew ? wx : wy;           // pixel footprint across / along the rows
      const lA = ew ? ly : lx;

      // individual plants every 0.3 m along the row, each a slightly different size and shade;
      // the detail fades out where one pixel covers many plants
      const w = wA / ROW_M;
      const detail = 1 - smooth(0.25, 0.7, wL / 0.3 > w ? wL / 0.3 : w);
      const rowI = Math.floor(across / ROW_M), plantI = Math.floor(along / 0.3);
      const gap = Math.abs(fract(along / 0.3) - 0.5) * 2;    // 0 at a plant's centre, 1 between two plants
      const size = 1 + ((0.7 + 0.6 * hash(rowI, plantI)) * (1 - 0.35 * gap * gap) - 1) * detail;

      // crop rows: plants cover the middle of each 0.75 m row; far away the rows blend into one colour
      const canopy = (0.26 + 0.1 * crop) * size;
      const e = w * 0.5 > 0.04 ? w * 0.5 : 0.04;
      const dc = Math.abs(fract(across / ROW_M) - 0.5);       // 0 on a row's centre line
      let leaf = 1 - smooth(canopy - e, canopy + e, dc);
      leaf += ((0.26 + 0.1 * crop) * 2 - leaf) * smooth(0.5, 1.2, w);
      // tramlines: two bare wheel ruts every 24 m
      const tram = Math.abs(Math.abs(fract(lA / TRAM) * TRAM - TRAM / 2) - 0.9);
      leaf *= smooth(0.2 - wA, 0.3 + wA, tram);

      // leaf shade varies per plant and is lighter at the top of each plant; soil has small clods
      const plant = 1 + ((hash(rowI, plantI + 7919) - 0.5) * 0.22 + 0.12 * (1 - (dc < canopy ? dc / canopy : 1))) * detail;
      const clod = 1 + (hash(Math.floor(gx / 0.18), Math.floor(gy / 0.18)) - 0.5) * 0.16 * detail;
      const wet = m * (1 - crop * 0.35);                        // older fields are a little more yellow

      // farm tracks between fields, with two darker ruts
      const track = Math.max(1 - smooth(TRACK - wx, TRACK + wx, lx), 1 - smooth(TRACK - wy, TRACK + wy, ly));
      const rut = lx < TRACK ? Math.abs(lx - TRACK / 2) : Math.abs(ly - TRACK / 2);
      const rutAmt = (1 - smooth(0.9, 1.4 + wx, Math.abs(rut - 1.1))) * detail;

      // slow cloud shadows drifting over the farm, then haze with distance (about 1 - e^-d/650, without Math.exp)
      const light = 1 - 0.17 * cloudGrid.at(gx - time * WIND_X, gy - time * WIND_Y);
      const fd = dist / 650;
      const fog = 1 - 1 / (1 + fd + 0.5 * fd * fd);

      let r = (SD[0] + (SW[0] - SD[0]) * m) * clod, g = (SD[1] + (SW[1] - SD[1]) * m) * clod, b = (SD[2] + (SW[2] - SD[2]) * m) * clod;
      r += ((LD[0] + (LW[0] - LD[0]) * wet) * plant - r) * leaf;
      g += ((LD[1] + (LW[1] - LD[1]) * wet) * plant - g) * leaf;
      b += ((LD[2] + (LW[2] - LD[2]) * wet) * plant - b) * leaf;
      r += (TR[0] + (RU[0] - TR[0]) * rutAmt - r) * track;
      g += (TR[1] + (RU[1] - TR[1]) * rutAmt - g) * track;
      b += (TR[2] + (RU[2] - TR[2]) * rutAmt - b) * track;
      r *= light; g *= light; b *= light;
      return rgb(r + (HZ[0] - r) * fog, g + (HZ[1] - g) * fog, b + (HZ[2] - b) * fog);
    }

    // Draw rows y0..y1 of a W x H picture into buf (Uint32Array of W * (y1 - y0) ABGR pixels).
    // cam = { x, y, alt, heading (rad, 0 = north, clockwise), pitch (rad, camera tilted down), roll (rad, right wing down), time (s) }
    function renderRows(cam, W, H, y0, y1, buf) {
      const tanH = Math.tan(FOV_H / 2), tanV = (tanH * H) / W;
      const sh = Math.sin(cam.heading), ch = Math.cos(cam.heading);
      const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
      const sr = Math.sin(cam.roll), cr = Math.cos(cam.roll);
      // camera axes: forward, then right and up turned by the bank angle
      const fX = sh * cp, fY = ch * cp, fZ = -sp;
      const u0X = sh * sp, u0Y = ch * sp, u0Z = cp;
      const rX = ch * cr - u0X * sr, rY = -sh * cr - u0Y * sr, rZ = -u0Z * sr;
      const uX = u0X * cr + ch * sr, uY = u0Y * cr - sh * sr, uZ = u0Z * cr;
      const pixA = (2 * tanH) / W;                            // angle covered by one pixel
      const pixE = (2 * tanV) / H;                            // the same, vertically (for the tree line edge)
      const alt = cam.alt, camX = cam.x, camY = cam.y, time = cam.time;
      soilGrid.ensure(camX, camY);
      cloudGrid.ensure(camX - time * WIND_X, camY - time * WIND_Y);
      let k = 0;
      for (let py = y0; py < y1; py++) {
        const v = (1 - (2 * (py + 0.5)) / H) * tanV;
        for (let px = 0; px < W; px++, k++) {
          const u = ((2 * (px + 0.5)) / W - 1) * tanH;
          const dx = fX + u * rX + v * uX, dy = fY + u * rY + v * uY, dz = fZ + u * rZ + v * uZ;
          const hl = Math.sqrt(dx * dx + dy * dy) || 1e-6;
          const len = Math.sqrt(hl * hl + dz * dz);
          const t = dz < 0 ? alt / -dz : Infinity;            // distance along the ray to the ground
          if (t * len > TREES_AT) { buf[k] = sky(dx, dy, dz / len, pixE / len); continue; }
          const dist = t * len, sinG = -dz / len;
          const hx = Math.abs(dx) / hl, hy = Math.abs(dy) / hl;
          const across = dist * pixA, along = across / (sinG > 0.02 ? sinG : 0.02);
          buf[k] = ground(camX + t * dx, camY + t * dy, hx * along + hy * across, hy * along + hx * across, dist, time);
        }
      }
    }

    return { renderRows };
  }

  // where this script was loaded from, so the worker is found next to it
  const SCRIPT_URL = typeof document !== 'undefined' && document.currentScript ? document.currentScript.src : null;

  // On the page: size the picture to the screen, hand bands of rows to workers (one per spare CPU core),
  // and put the finished frame on the canvas. Resolution adapts so frames keep up with the display.
  function createView(canvas) {
    const ctx = canvas.getContext('2d');
    const MIN_W = 240, MAX_W = 960;     // picture width limits in pixels
    let W = 0, H = 0, img = null, frame = null;
    let quality = 0.7;                  // share of the screen's real pixels to draw (adapts 0.35..1)
    let avgMs = 0, warmup = 6;          // frame time average; the first frames build caches, so they don't count
    let lastChange = 0;                 // at most one resolution change a second, so it settles instead of flipping
    let local = null;                   // renderer on this thread, if workers can't be used

    // background workers
    let workers = [], busy = 0, started = 0, mixed = false; // mixed: a band came back at an old size
    const spare = [];
    function stopWorkers() { workers.forEach((w) => w.terminate()); workers = []; busy = 0; }
    if (typeof Worker !== 'undefined' && SCRIPT_URL) {
      try {
        const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
        const url = new URL('field-worker.js', SCRIPT_URL);
        for (let i = 0; i < n; i++) {
          const w = new Worker(url);
          w.onmessage = onBand;
          w.onerror = stopWorkers; // e.g. blocked or failed to load: fall back to drawing on this thread
          workers.push(w);
        }
      } catch { stopWorkers(); }
    }

    function resize() {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const dpr = Math.min(self.devicePixelRatio || 1, 2);
      const w = Math.max(MIN_W, Math.min(MAX_W, Math.round((r.width * dpr * quality) / 16) * 16));
      const h = Math.max(16, Math.round((w * r.height) / r.width));
      if (w !== W || h !== H) {
        W = w; H = h; // the canvas itself is resized in show(), together with the first frame at the new size
        img = ctx.createImageData(W, H);
        frame = new Uint32Array(img.data.buffer);
      }
      return true;
    }

    // more pixels while frames come in fast, fewer when they fall behind (aim: about 60 frames a second)
    function adapt(ms) {
      if (warmup > 0) { warmup--; return; }
      avgMs = avgMs ? avgMs * 0.85 + ms * 0.15 : ms;
      const now = performance.now();
      if (now - lastChange < 1000) return;
      if (avgMs > 20 && quality > 0.35) { quality = Math.max(0.35, quality - 0.1); avgMs = 0; lastChange = now; }
      else if (avgMs < 10 && quality < 1) { quality = Math.min(1, quality + 0.05); avgMs = 0; lastChange = now; }
    }

    // resizing a canvas clears it, so the size changes in the same step as drawing the new frame (no blank flash)
    function show() {
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      ctx.putImageData(img, 0, 0);
    }

    function onBand(e) {
      const { i, w, h, y0, buf } = e.data;
      spare[i] = buf;
      if (w === W && h === H) frame.set(new Uint32Array(buf), y0 * W); // a band drawn for an old size is dropped
      else mixed = true;
      if (--busy === 0) {
        if (!mixed) show(); // an incomplete frame is never shown; the previous one stays up
        adapt(performance.now() - started);
      }
    }

    function render(cam) {
      if (!resize()) return;
      if (!workers.length) {
        local ??= createRenderer();
        const t0 = performance.now();
        local.renderRows(cam, W, H, 0, H, frame);
        show();
        adapt(performance.now() - t0);
        return;
      }
      if (busy) return; // the last frame is still being drawn: skip this one, the page stays smooth
      started = performance.now();
      mixed = false;
      const step = Math.ceil(H / workers.length);
      const jobs = [];
      for (let i = 0; i < workers.length; i++) {
        const y0 = i * step, y1 = Math.min(H, y0 + step);
        if (y0 < y1) jobs.push([i, y0, y1]);
      }
      busy = jobs.length;
      for (const [i, y0, y1] of jobs) {
        const bytes = W * (y1 - y0) * 4;
        const buf = spare[i] && spare[i].byteLength === bytes ? spare[i] : new ArrayBuffer(bytes);
        spare[i] = null;
        workers[i].postMessage({ i, cam, w: W, h: H, y0, y1, buf }, [buf]);
      }
    }

    // size and how it's drawn, for checking in the browser console
    return { render, get stats() { return { width: W, height: H, workers: workers.length, quality }; } };
  }

  root.FieldView = { soilAt, createRenderer, createView };
})(self);
