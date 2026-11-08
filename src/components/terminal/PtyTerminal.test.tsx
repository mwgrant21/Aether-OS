import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { AetherStoreProvider } from '../../state/store';
import { PtyTerminal, prepareClaudeTerminal, focusClaudeTerminal } from './PtyTerminal';
const mocks = vi.hoisted(() => ({ write: vi.fn(), focus: vi.fn(), reset: vi.fn(), resize: vi.fn(), fitTo: undefined as { cols: number; rows: number } | undefined }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; write = mocks.write; focus = mocks.focus; reset = mocks.reset;
  resize(cols: number, rows: number) { mocks.resize(cols, rows); this.cols = cols; this.rows = rows; }
  loadAddon(addon: { term?: unknown }) { addon.term = this; } open() {} onData() {} onResize() {}
} }));
const markers = vi.hoisted(() => { const setEnabled = vi.fn(); return { setEnabled, attach: vi.fn(() => ({ setEnabled, flush() {}, dispose() {} })) }; });
vi.mock('./terminalMarkerDecorations', () => ({ attachTerminalMarkers: markers.attach }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {
  term?: { cols: number; rows: number };
  fit() { if (mocks.fitTo && this.term) { this.term.cols = mocks.fitTo.cols; this.term.rows = mocks.fitTo.rows; } }
} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as unknown as { aetherElectron?: unknown }).aetherElectron; });
it('subscribes before ensuring a session and does not restart on tab remount', () => {
  let receive: ((value: string) => void) | undefined;
  const start = vi.fn(() => { receive?.('startup or replay'); return Promise.resolve(); });
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: { pty: {
    start, onData: (callback: (value: string) => void) => { receive = callback; return () => {}; }, write() {}, resize() {},
  } } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  prepareClaudeTerminal();
  expect(start).not.toHaveBeenCalled();
  receive?.('connected output before Terminal mounts');
  expect(mocks.write).toHaveBeenCalledWith('connected output before Terminal mounts');
  focusClaudeTerminal();
  const first = render(<StrictMode><AetherStoreProvider><PtyTerminal /></AetherStoreProvider></StrictMode>);
  expect(start).not.toHaveBeenCalled();
  expect(mocks.focus).toHaveBeenCalledTimes(2);
  focusClaudeTerminal();
  expect(mocks.focus).toHaveBeenCalledTimes(3);
  expect(start).not.toHaveBeenCalled();
  first.unmount();
  render(<AetherStoreProvider><PtyTerminal /></AetherStoreProvider>);
  expect(mocks.write).toHaveBeenCalledWith('startup or replay');
  expect(start).toHaveBeenCalledOnce();
});

it('enables marker colors from cfg.terminalMarkerColors and follows the toggle', async () => {
  vi.resetModules();
  markers.attach.mockClear(); markers.setEnabled.mockClear();
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: { pty: { start: vi.fn(() => Promise.resolve()), onData: () => () => {}, write() {}, resize() {} } } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const { AetherStoreProvider: Provider, useAetherStore: useStore } = await import('../../state/store');
  const { PtyTerminal: Fresh } = await import('./PtyTerminal');
  const Flip = () => { const { dispatch } = useStore(); return <button onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { terminalMarkerColors: false } })}>flip</button>; };
  const { getByText } = render(<Provider><Fresh /><Flip /></Provider>);
  expect(markers.attach).toHaveBeenCalledOnce();
  expect(markers.setEnabled).toHaveBeenLastCalledWith(true);
  fireEvent.click(getByText('flip'));
  expect(markers.setEnabled).toHaveBeenLastCalledWith(false);
});

async function mountSnap(withOnSnap = true) {
  vi.resetModules();
  mocks.write.mockClear(); mocks.reset.mockClear(); mocks.resize.mockClear(); mocks.fitTo = undefined;
  let snap: ((s: { cols: number; rows: number; d: string }) => void) | undefined;
  const resize = vi.fn();
  const order: string[] = [];
  const start = vi.fn(() => { order.push('start'); return Promise.resolve(); });
  const pty = { start, onData: () => () => {}, write() {}, resize, ...(withOnSnap ? { onSnap: (cb: typeof snap) => { order.push('onSnap'); snap = cb; return () => {}; } } : {}) };
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: { pty } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const { AetherStoreProvider: Provider } = await import('../../state/store');
  const { PtyTerminal: Fresh } = await import('./PtyTerminal');
  render(<Provider><Fresh /></Provider>);
  return { snap: snap!, resize, order };
}

it('repaints from a snap: reset, resize to the mirror, write, then refit and tell main the real size', async () => {
  const { snap, resize, order } = await mountSnap();
  expect(order).toEqual(['onSnap', 'start']);
  mocks.fitTo = { cols: 120, rows: 40 };
  snap({ cols: 100, rows: 30, d: 'screen' });
  expect(mocks.reset).toHaveBeenCalledOnce();
  expect(mocks.resize).toHaveBeenCalledWith(100, 30);
  expect(mocks.write.mock.calls[0][0]).toBe('screen');
  expect(resize).not.toHaveBeenCalled();
  mocks.write.mock.calls[0][1]();
  expect(resize).toHaveBeenCalledWith(120, 40);
});

it('does not resend the size when the fitted size equals the snap size, and skips resize for invalid sizes', async () => {
  const { snap, resize } = await mountSnap();
  snap({ cols: 100, rows: 30, d: 'screen' });
  mocks.write.mock.calls[0][1]();
  expect(resize).not.toHaveBeenCalled();
  mocks.resize.mockClear();
  snap({ cols: 0, rows: 1.5, d: 'again' });
  expect(mocks.resize).not.toHaveBeenCalled();
});

it('ignores an empty snap', async () => {
  const { snap } = await mountSnap();
  snap({ cols: 100, rows: 30, d: '' });
  expect(mocks.reset).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
});

it('mounts and starts without throwing when the preload has no onSnap', async () => {
  const { order } = await mountSnap(false);
  expect(order).toEqual(['start']);
});
