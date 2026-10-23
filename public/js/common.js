// Shared helpers for both pages.

// Light/dark theme. The inline script in <head> sets data-theme before first paint; this wires the toggle button,
// remembers the choice, and follows the system setting until the visitor picks one. Fires "themechange" on window.
(() => {
  const KEY = 'agrifly-theme';
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const saved = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const apply = (theme) => {
    root.dataset.theme = theme;
    const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    for (const b of document.querySelectorAll('.theme-toggle')) { b.setAttribute('aria-label', label); b.title = label; }
    dispatchEvent(new Event('themechange'));
  };
  const sync = () => apply(saved() || (system.matches ? 'dark' : 'light'));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync); else sync();
  system.addEventListener('change', () => { if (!saved()) sync(); });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.theme-toggle')) return;
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(KEY, next); } catch { /* storage blocked: still switches for this visit */ }
    apply(next);
  });
})();

window.AgriFly = {
  // "gas_raw" -> "Gas raw", "soilMoisture" -> "Soil moisture", "co2" -> "CO2"
  prettify(key) {
    const ACRONYMS = { co2: 'CO2', uv: 'UV', ph: 'pH', gps: 'GPS', tvoc: 'TVOC', ndvi: 'NDVI', pm25: 'PM2.5', pm10: 'PM10' };
    const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[\s_.-]+/).filter(Boolean)
      .map((w) => ACRONYMS[w.toLowerCase()] || w.toLowerCase());
    if (words.length && words[0] === words[0].toLowerCase()) words[0] = words[0][0].toUpperCase() + words[0].slice(1);
    return words.join(' ');
  },

  format(value) {
    const abs = Math.abs(value);
    if (abs >= 1000) return Math.round(value).toLocaleString();
    if (abs >= 100) return value.toFixed(0);
    if (abs >= 10) return value.toFixed(1);
    return value.toFixed(2).replace(/\.?0+$/, '') || '0';
  },

  // 12000 -> "12 s", 80000 -> "1 min 20 s", 7500000 -> "2 h 5 min"
  duration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
    return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
  },

  ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  },
};
