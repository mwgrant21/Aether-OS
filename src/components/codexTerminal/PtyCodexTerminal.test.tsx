import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ write: vi.fn(), reset: vi.fn(), resize: vi.fn(), fitTo: undefined as { cols: number; rows: number } | undefined }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; write = mocks.write; reset = mocks.reset;
  resize(cols: number, rows: number) { mocks.resize(cols, rows); this.cols = cols; this.rows = rows; }
  loadAddon(addon: { term?: unknown }) { addon.term = this; } open() {} onData() {} onResize() {}
} }));
const markers = vi.hoisted(() => { const setEnabled = vi.fn(); return { setEnabled, attach: vi.fn(() => ({ setEnabled, flush() {}, dispose() {} })) }; });
vi.mock('../terminal/terminalMarkerDecorations', () => ({ attachTerminalMarkers: markers.attach }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {
  term?: { cols: number; rows: number };
  fit() { if (mocks.fitTo && this.term) { this.term.cols = mocks.fitTo.cols; this.term.rows = mocks.fitTo.rows; } }
} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as unknown as { aetherElectron?: unknown }).aetherElectron; });

async function mountSnap(withOnSnap = true) {
  vi.resetModules();
  mocks.write.mockClear(); mocks.reset.mockClear(); mocks.resize.mockClear(); mocks.fitTo = undefined;
  let snap: ((s: { cols: number; rows: number; d: string }) => void) | undefined;
  const resize = vi.fn();
  let data: ((d: string) => void) | undefined;
  const order: string[] = [];
  const start = vi.fn(() => { order.push('start'); return Promise.resolve(); });
  const codexPty = { start, onData: (cb: typeof data) => { order.push('onData'); data = cb; return () => {}; }, write() {}, resize, ...(withOnSnap ? { onSnap: (cb: typeof snap) => { order.push('onSnap'); snap = cb; return () => {}; } } : {}) };
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: { codexPty } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const { AetherStoreProvider: Provider } = await import('../../state/store');
  const { PtyCodexTerminal: Fresh } = await import('./PtyCodexTerminal');
  const view = render(<Provider><Fresh /></Provider>);
  return { snap: snap!, resize, order, data: data!, start, view, Provider, Fresh };
}

it('repaints from a snap: reset, resize to the mirror, write, then refit and tell main the real size', async () => {
  const { snap, resize, order } = await mountSnap();
  expect(order).toEqual(['onSnap', 'start', 'onData']);
  mocks.fitTo = { cols: 120, rows: 40 };
  snap({ cols: 100, rows: 30, d: 'screen' });
  expect(mocks.reset).not.toHaveBeenCalled();
  mocks.write.mock.calls[0][1](); // the barrier drained
  expect(mocks.reset).toHaveBeenCalledOnce();
  expect(mocks.resize).toHaveBeenCalledWith(100, 30);
  expect(mocks.write.mock.calls[1][0]).toBe('screen');
  expect(resize).not.toHaveBeenCalled();
  mocks.write.mock.calls[1][1]();
  expect(resize).toHaveBeenCalledWith(120, 40);
});

it('does not resend the size when the fitted size equals the snap size, and skips resize for invalid sizes', async () => {
  const { snap, resize } = await mountSnap();
  snap({ cols: 100, rows: 30, d: 'screen' });
  mocks.write.mock.calls[0][1]();
  mocks.write.mock.calls[1][1]();
  expect(resize).not.toHaveBeenCalled();
  mocks.resize.mockClear();
  snap({ cols: 0, rows: 1.5, d: 'again' });
  mocks.write.mock.calls[2][1]();
  expect(mocks.resize).not.toHaveBeenCalled();
});

it('ignores an empty snap', async () => {
  const { snap } = await mountSnap();
  snap({ cols: 100, rows: 30, d: '' });
  expect(mocks.reset).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
});

it('mounts and starts without throwing when the preload has no onSnap, onExit or onAlive', async () => {
  const { order } = await mountSnap(false);
  expect(order).toEqual(['start', 'onData']);
});

it('applies a snap behind a write barrier: earlier chunks drain first, chunks that arrive meanwhile follow the snapshot', async () => {
  const { snap, data } = await mountSnap();
  data('before');
  snap({ cols: 100, rows: 30, d: 'screen' });
  data('meanwhile');
  expect(mocks.write.mock.calls.map(c => c[0])).toEqual(['before', '']);
  expect(mocks.reset).not.toHaveBeenCalled();
  mocks.write.mock.calls[1][1](); // barrier: 'before' has been parsed
  expect(mocks.write.mock.calls.map(c => c[0])).toEqual(['before', '', 'screen', 'meanwhile']);
  expect(mocks.reset.mock.invocationCallOrder[0]).toBeLessThan(mocks.write.mock.invocationCallOrder[2]);
  data('after');
  expect(mocks.write).toHaveBeenLastCalledWith('after');
});

it('starts the session once across unmount and remount', async () => {
  const { start, view, Provider, Fresh } = await mountSnap();
  view.unmount();
  render(<Provider><Fresh /></Provider>);
  expect(start).toHaveBeenCalledOnce();
});

it('shows the Electron-required message when there is no preload', async () => {
  vi.resetModules();
  const { AetherStoreProvider: Provider } = await import('../../state/store');
  const { PtyCodexTerminal: Fresh } = await import('./PtyCodexTerminal');
  const { container } = render(<Provider><Fresh /></Provider>);
  expect(container.textContent).toMatch(/^Codex terminal requires the Electron app/);
});
