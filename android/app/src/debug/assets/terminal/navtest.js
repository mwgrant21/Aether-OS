// Debug-only. Exercises every way a page could leave the asset origin.
const log = (s) => { console.log('navtest: ' + s); document.getElementById('log').textContent += s + '\n'; };
const tests = {
  open: () => { const w = window.open('https://example.com/', '_blank'); log('window.open returned ' + (w ? 'a window (FAIL)' : 'null (blocked)')); },
  assign: () => { log('location.assign issued; page must stay on this URL'); location.assign('https://example.com/'); },
  fetch: () => fetch('https://example.com/').then(() => log('fetch resolved (FAIL)'), (e) => log('fetch rejected: ' + e.message)),
  alert: () => { alert('should not show'); log('alert returned (dialog suppressed)'); },
};
for (const [id, fn] of Object.entries(tests)) document.getElementById(id).addEventListener('click', fn);
document.getElementById('link').addEventListener('click', () => log('link tapped; page must stay on this URL'));
// Automatic attempts so an adb-only run (no taps) still produces evidence.
tests.open();
tests.fetch();
