// Landing hero: renders the latest reading as a Betaflight-style OSD. Polls /api/latest.
(() => {
  const $ = (id) => document.getElementById(id);
  const OFFLINE_AFTER_MS = 10000;
  const MAX_ROWS = 4;
  // short OSD labels for the usual sensors; anything else gets its key, cut to fit
  const SHORT = { temperature: 'TEMP', humidity: 'HUM', pressure: 'PRES', light: 'LUX', soil: 'SOIL', gas_raw: 'GAS' };

  const osdNumber = (v) => AgriFly.format(v);
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour12: false });

  async function refresh() {
    let data;
    try {
      data = await (await fetch('/api/latest', { cache: 'no-store' })).json();
    } catch {
      return offline('NO SERVER', 'START THE LAPTOP SERVER');
    }
    const r = data.latest;
    if (!r) return offline('NO SIGNAL', 'WAITING FOR THE DRONE');
    const age = data.now - r.t;
    $('osd-device').textContent = r.device;
    $('osd-time').textContent = clock(r.t);
    if (age > OFFLINE_AFTER_MS) return offline('DEVICE OFFLINE', `LAST DATA ${AgriFly.ago(age)}`);

    $('osd-link').textContent = 'LINK OK';
    $('osd-link').className = 'link-ok';
    $('osd-alert').hidden = true;
    const rows = Object.entries(r.readings).slice(0, MAX_ROWS).map(([key, { value, unit }]) => {
      const row = document.createElement('div');
      const label = document.createElement('span');
      label.textContent = SHORT[key] || key.replace(/_/g, ' ').slice(0, 5);
      const val = document.createElement('span');
      val.textContent = `${osdNumber(value)} ${unit}`.trim();
      row.append(label, val);
      return row;
    });
    $('osd-readings').replaceChildren(...rows);
    $('osd-gps').innerHTML = '';
    $('osd-gps').append(...(r.gps
      ? [`${Math.abs(r.gps.lat).toFixed(5)} ${r.gps.lat >= 0 ? 'N' : 'S'}`, `${Math.abs(r.gps.lon).toFixed(5)} ${r.gps.lon >= 0 ? 'E' : 'W'}`]
      : ['NO GPS FIX']).map((line) => Object.assign(document.createElement('div'), { textContent: line })));
  }

  function offline(title, detail) {
    $('osd-link').textContent = 'NO LINK';
    $('osd-link').className = 'link-lost';
    $('osd-alert').hidden = false;
    $('osd-alert').firstChild.textContent = title;
    $('osd-alert').querySelector('small').textContent = detail;
    $('osd-readings').replaceChildren();
    $('osd-gps').replaceChildren();
  }

  refresh();
  setInterval(refresh, 2000);
})();
