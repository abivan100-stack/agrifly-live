// Small live strip on the landing page: polls /api/latest.
(() => {
  const strip = document.getElementById('live-strip');
  const OFFLINE_AFTER_MS = 10000;

  async function refresh() {
    let data;
    try {
      data = await (await fetch('/api/latest', { cache: 'no-store' })).json();
    } catch {
      return render(null, 'Server unreachable');
    }
    const r = data.latest;
    if (!r || data.now - r.t > OFFLINE_AFTER_MS) {
      return render(null, r ? `Device offline · last data ${AgriFly.ago(data.now - r.t)}` : 'Device offline');
    }
    render(r);
  }

  function render(record, offlineText) {
    strip.replaceChildren();
    const pill = document.createElement('span');
    pill.className = 'pill' + (record ? ' live' : ' offline');
    pill.textContent = record ? 'Live from the field' : offlineText;
    strip.append(pill);
    if (!record) return;
    for (const [key, { value, unit }] of Object.entries(record.readings).slice(0, 4)) {
      const item = document.createElement('span');
      item.className = 'item';
      const label = document.createElement('span');
      label.textContent = AgriFly.prettify(key) + ' ';
      const val = document.createElement('b');
      val.textContent = `${AgriFly.format(value)} ${unit}`.trim();
      item.append(label, val);
      strip.append(item);
    }
  }

  refresh();
  setInterval(refresh, 4000);
})();
