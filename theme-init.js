// Runs before first paint: apply the last theme (mirrored from storage.local by newtab.js)
// so a light-mode page doesn't flash dark while settings load.
try {
  if (localStorage.getItem('theme') === 'light') document.documentElement.dataset.theme = 'light';
} catch { /* storage unavailable: default dark */ }
