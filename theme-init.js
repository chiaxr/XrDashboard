// Runs before first paint: apply the last theme (mirrored from storage.local by newtab.js)
// so the page doesn't flash the wrong theme while settings load. 'auto' follows Firefox's
// light/dark appearance.
try {
  const pref = localStorage.getItem('theme');
  const light = pref === 'light' || (pref === 'auto' && !matchMedia('(prefers-color-scheme: dark)').matches);
  if (light) document.documentElement.dataset.theme = 'light';
} catch { /* storage unavailable: default dark */ }
