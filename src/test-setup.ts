// Node 22+ (including the Node 25 toolchain this repo targets) defines a global
// `localStorage`/`sessionStorage` that is inert unless the process is started with
// `--localstorage-file`. Vitest's jsdom environment only copies keys onto `globalThis`
// that are NOT already present there, so Node's broken global shadows jsdom's real,
// working implementation. `window` is aliased to `globalThis` itself by vitest's jsdom
// environment, so `window.localStorage` also resolves to the broken one — the genuine
// jsdom Window instance lives at `globalThis.jsdom.window`. Pull the real storage from
// there and force it back onto `globalThis` before any tests run.
const realWindow = (globalThis as unknown as { jsdom?: { window?: Window } }).jsdom?.window;

if (realWindow?.localStorage) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: realWindow.localStorage,
    configurable: true,
    writable: true,
  });
}
if (realWindow?.sessionStorage) {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: realWindow.sessionStorage,
    configurable: true,
    writable: true,
  });
}
