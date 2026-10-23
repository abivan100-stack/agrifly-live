// Landing hero: puts the latest readings on the field pins. Polls /api/latest.
(() => {
  const pins = [...document.querySelectorAll('.pin')];
  const dot = document.getElementById('field-dot');
  const status = document.getElementById('field-status');
  const OFFLINE_AFTER_MS = 10000;

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.querySelector('#field-map svg').pauseAnimations();
  }

  async function refresh() {
    let data;
    try {
      data = await (await fetch('/api/latest', { cache: 'no-store' })).json();
    } catch {
      return showIdle('Server unreachable. Check that the laptop server is running.');
    }
    const r = data.latest;
    if (!r) return showIdle('Device offline. No readings received yet.');
    const age = data.now - r.t;
    if (age > OFFLINE_AFTER_MS) return showIdle(`Device offline. Last reading ${AgriFly.ago(age)}.`);

    const entries = Object.entries(r.readings).slice(0, pins.length);
    pins.forEach((pin, i) => {
      const [key, reading] = entries[i] || [];
      pin.hidden = !key;
      if (!key) return;
      pin.classList.remove('idle');
      pin.querySelector('b').textContent = `${AgriFly.format(reading.value)} ${reading.unit}`.trim();
      pin.querySelector('.tag span').textContent = AgriFly.prettify(key);
    });
    dot.classList.add('live');
    status.textContent = `Live from the field, updated ${AgriFly.ago(age)}`;
  }

  function showIdle(text) {
    for (const pin of pins) {
      pin.hidden = false;
      pin.classList.add('idle');
      pin.querySelector('b').textContent = '--';
      pin.querySelector('.tag span').textContent = 'offline';
    }
    dot.classList.remove('live');
    status.textContent = text;
  }

  refresh();
  setInterval(refresh, 3000);
})();
