import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { AetherStoreProvider } from '../../state/store';
import { PtyTerminal2 } from './PtyTerminal2';
import { Terminal2View } from './Terminal2View';
const mocks = vi.hoisted(() => ({ write: vi.fn(), reset: vi.fn(), termResize: vi.fn(), fitTo: undefined as { cols: number; rows: number } | undefined, data: undefined as ((input: string) => void) | undefined, paste: vi.fn(), hasSelection: vi.fn(() => false), getSelection: vi.fn(() => ''), key: undefined as ((ev: KeyboardEvent) => boolean) | undefined, modes: { mouseTrackingMode: 'none' } }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; write = mocks.write; reset = mocks.reset;
  modes = mocks.modes; hasSelection = mocks.hasSelection; getSelection = mocks.getSelection; paste = mocks.paste;
  attachCustomKeyEventHandler(cb: (ev: KeyboardEvent) => boolean) { mocks.key = cb; }
  resize(cols: number, rows: number) { mocks.termResize(cols, rows); this.cols = cols; this.rows = rows; }
  loadAddon(addon: { term?: unknown }) { addon.term = this; } open() {} onData(cb: (input: string) => void) { mocks.data = cb; } onResize() {}
} }));
const markers = vi.hoisted(() => { const setEnabled = vi.fn(); return { setEnabled, attach: vi.fn(() => ({ setEnabled, flush() {}, dispose() {} })) }; });
vi.mock('../terminal/terminalMarkerDecorations', () => ({ attachTerminalMarkers: markers.attach }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {
  term?: { cols: number; rows: number };
  fit() { if (mocks.fitTo && this.term) { this.term.cols = mocks.fitTo.cols; this.term.rows = mocks.fitTo.rows; } }
} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as unknown as { aetherElectron?: unknown }).aetherElectron; delete (navigator as unknown as { clipboard?: unknown }).clipboard; });
it('starts its own session once, after subscribing, and keeps it across tab remounts without touching the pinned pty', () => {
  let receive: ((value: string) => void) | undefined;
  const start = vi.fn(() => { receive?.('first output'); return Promise.resolve(); });
  const pinnedStart = vi.fn();
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: {
    pty: { start: pinnedStart, onData: () => () => {}, write() {}, resize() {} },
    terminal2Pty: { start, onData: (callback: (value: string) => void) => { receive = callback; return () => {}; }, onExit: () => () => {}, onAlive: () => () => {}, write() {}, resize() {} },
  } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const first = render(<AetherStoreProvider><PtyTerminal2 /></AetherStoreProvider>);
  expect(start).toHaveBeenCalledOnce();
  expect(mocks.write).toHaveBeenCalledWith('first output');
  first.unmount();
  render(<AetherStoreProvider><PtyTerminal2 /></AetherStoreProvider>);
  expect(start).toHaveBeenCalledOnce();
  expect(pinnedStart).not.toHaveBeenCalled();
});

async function mountExited() {
  vi.resetModules();
  mocks.write.mockClear(); mocks.reset.mockClear();
  const cbs: { exit?: () => void; alive?: () => void } = {};
  const start = vi.fn(() => Promise.resolve());
  const resize = vi.fn();
  const ptyWrite = vi.fn();
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: {
    terminal2Pty: { start, onData: () => () => {}, onExit: (cb: () => void) => { cbs.exit = cb; return () => {}; }, onAlive: (cb: () => void) => { cbs.alive = cb; return () => {}; }, write: ptyWrite, resize },
  } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const { AetherStoreProvider: Provider } = await import('../../state/store');
  const { PtyTerminal2: Fresh } = await import('./PtyTerminal2');
  render(<Provider><Fresh /></Provider>);
  return { cbs, start, resize, ptyWrite };
}

it('shows the exit banner and forwards Enter after exit to main without starting or resetting itself', async () => {
  const { cbs, start, ptyWrite } = await mountExited();
  expect(start).toHaveBeenCalledOnce();
  cbs.exit!();
  expect(mocks.write).toHaveBeenCalledWith('\r\n[process exited - press Enter to restart]\r\n');
  mocks.data!('\r');
  expect(ptyWrite).toHaveBeenCalledWith('\r');
  expect(start).toHaveBeenCalledOnce();
  expect(mocks.reset).not.toHaveBeenCalled();
});

it('resets the terminal and re-sends its size when main reports the session alive', async () => {
  const { cbs, resize } = await mountExited();
  cbs.alive!();
  expect(mocks.reset).toHaveBeenCalledOnce();
  expect(resize).toHaveBeenCalledWith(80, 24);
});

it('forwards non-Enter input after exit as-is (the drop-other-input filter moved to main)', async () => {
  const { cbs, ptyWrite } = await mountExited();
  cbs.exit!();
  mocks.data!('x');
  expect(ptyWrite).toHaveBeenCalledWith('x');
});

async function mountFresh() {
  vi.resetModules();
  mocks.paste.mockClear();
  const ptyWrite = vi.fn();
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: {
    terminal2Pty: { start: vi.fn(() => Promise.resolve()), onData: () => () => {}, onExit: () => () => {}, onAlive: () => () => {}, write: ptyWrite, resize() {} },
  } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const { AetherStoreProvider: Provider } = await import('../../state/store');
  const { PtyTerminal2: Fresh } = await import('./PtyTerminal2');
  const { container } = render(<Provider><Fresh /></Provider>);
  return { host: container.firstElementChild!.firstElementChild as HTMLElement, ptyWrite };
}
const stubClipboard = (readText: unknown, writeText: unknown) => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText, writeText } });

it('copies the selection to the clipboard on mouse release only when something is selected', async () => {
  const writeText = vi.fn(() => Promise.resolve());
  stubClipboard(vi.fn(), writeText);
  mocks.hasSelection.mockReturnValue(true);
  mocks.getSelection.mockReturnValue('hello');
  const { host } = await mountFresh();
  fireEvent.mouseUp(document);
  expect(writeText).not.toHaveBeenCalled();
  fireEvent.mouseDown(host);
  fireEvent.mouseUp(document);
  expect(writeText).toHaveBeenCalledOnce();
  expect(writeText).toHaveBeenCalledWith('hello');
  fireEvent.mouseDown(host, { button: 2 });
  fireEvent.mouseUp(document);
  expect(writeText).toHaveBeenCalledOnce();
  fireEvent.mouseDown(host);
  fireEvent.mouseDown(host, { button: 2 });
  fireEvent.mouseUp(document, { button: 2 });
  expect(writeText).toHaveBeenCalledOnce();
  fireEvent.mouseUp(document);
  expect(writeText).toHaveBeenCalledTimes(2);
  mocks.hasSelection.mockReturnValue(false);
  fireEvent.mouseDown(host);
  fireEvent.mouseUp(document);
  expect(writeText).toHaveBeenCalledTimes(2);
});

it('pastes clipboard text on Ctrl+V and Ctrl+Shift+V through xterm paste and swallows the key, leaving Ctrl+C alone', async () => {
  stubClipboard(vi.fn(() => Promise.resolve('abc')), vi.fn());
  const { ptyWrite } = await mountFresh();
  const key = (init: Partial<KeyboardEvent>) => ({ type: 'keydown', ctrlKey: true, altKey: false, metaKey: false, preventDefault: vi.fn(), ...init }) as unknown as KeyboardEvent;
  const v = key({ key: 'v', code: 'KeyV' });
  expect(mocks.key!(v)).toBe(false);
  expect(v.preventDefault).toHaveBeenCalled();
  await Promise.resolve(); await Promise.resolve();
  expect(mocks.paste).toHaveBeenCalledWith('abc');
  expect(mocks.key!(key({ key: 'V', code: 'KeyV', shiftKey: true }))).toBe(false);
  await Promise.resolve(); await Promise.resolve();
  expect(mocks.paste).toHaveBeenCalledTimes(2);
  expect(mocks.key!(key({ key: 'v', code: 'KeyV', type: 'keyup' }))).toBe(false);
  expect(mocks.key!(key({ key: 'v', code: 'KeyV', repeat: true }))).toBe(false);
  expect(mocks.key!(key({ key: 'm', code: 'KeyV' }))).toBe(false);
  await Promise.resolve(); await Promise.resolve();
  expect(mocks.paste).toHaveBeenCalledTimes(3);
  expect(mocks.key!(key({ key: 'v', code: 'KeyM' }))).toBe(true);
  await Promise.resolve(); await Promise.resolve();
  expect(mocks.paste).toHaveBeenCalledTimes(3);
  expect(mocks.key!(key({ key: 'c', code: 'KeyC' }))).toBe(true);
  await Promise.resolve(); await Promise.resolve();
  expect(mocks.paste).toHaveBeenCalledTimes(3);
  expect(ptyWrite).not.toHaveBeenCalled();
});

it('right-click pastes unless a program is tracking the mouse', async () => {
  stubClipboard(vi.fn(() => Promise.resolve('abc')), vi.fn());
  mocks.modes.mouseTrackingMode = 'none';
  const { host } = await mountFresh();
  expect(fireEvent.contextMenu(host)).toBe(false);
  await Promise.resolve(); await Promise.resolve();
  expect(mocks.paste).toHaveBeenCalledWith('abc');
  mocks.paste.mockClear();
  mocks.modes.mouseTrackingMode = 'any';
  expect(fireEvent.contextMenu(host)).toBe(true);
  await Promise.resolve(); await Promise.resolve();
  expect(mocks.paste).not.toHaveBeenCalled();
});

it('enables marker colors from cfg.terminalMarkerColors and follows the toggle', async () => {
  vi.resetModules();
  markers.attach.mockClear(); markers.setEnabled.mockClear();
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: {
    terminal2Pty: { start: vi.fn(() => Promise.resolve()), onData: () => () => {}, onExit: () => () => {}, onAlive: () => () => {}, write() {}, resize() {} },
  } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const { AetherStoreProvider: Provider, useAetherStore: useStore } = await import('../../state/store');
  const { PtyTerminal2: Fresh } = await import('./PtyTerminal2');
  const Flip = () => { const { dispatch } = useStore(); return <button onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { terminalMarkerColors: false } })}>flip</button>; };
  const { getByText } = render(<Provider><Fresh /><Flip /></Provider>);
  expect(markers.attach).toHaveBeenCalledOnce();
  expect(markers.setEnabled).toHaveBeenLastCalledWith(true);
  fireEvent.click(getByText('flip'));
  expect(markers.setEnabled).toHaveBeenLastCalledWith(false);
});

it('labels the second terminal Terminal Beta in its banner and its no-Electron fallback', () => {
  const { getByText } = render(<AetherStoreProvider><Terminal2View /></AetherStoreProvider>);
  expect(getByText('TERMINAL BETA · UNMONITORED')).toBeTruthy();
  expect(getByText(/^Terminal Beta requires the Electron app/)).toBeTruthy();
});

async function mountSnap(withOnSnap = true) {
  vi.resetModules();
  mocks.write.mockClear(); mocks.reset.mockClear(); mocks.termResize.mockClear(); mocks.fitTo = undefined;
  let snap: ((s: { cols: number; rows: number; d: string }) => void) | undefined;
  const resize = vi.fn();
  let data: ((d: string) => void) | undefined;
  let exit: (() => void) | undefined;
  const order: string[] = [];
  const start = vi.fn(() => { order.push('start'); });
  const terminal2Pty = { start, onData: (cb: typeof data) => { data = cb; return () => {}; }, onExit: (cb: typeof exit) => { exit = cb; return () => {}; }, onAlive: () => () => {}, write() {}, resize, ...(withOnSnap ? { onSnap: (cb: typeof snap) => { order.push('onSnap'); snap = cb; return () => {}; } } : {}) };
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: { terminal2Pty } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const { AetherStoreProvider: Provider } = await import('../../state/store');
  const { PtyTerminal2: Fresh } = await import('./PtyTerminal2');
  render(<Provider><Fresh /></Provider>);
  return { snap: snap!, resize, order, data: data!, exit: exit! };
}

it('repaints from a snap with no alive message: reset, resize to the mirror, write, then refit and tell main the real size', async () => {
  const { snap, resize, order } = await mountSnap();
  expect(order).toEqual(['onSnap', 'start']);
  mocks.fitTo = { cols: 120, rows: 40 };
  snap({ cols: 100, rows: 30, d: 'screen' });
  expect(mocks.reset).not.toHaveBeenCalled();
  mocks.write.mock.calls[0][1](); // the barrier drained
  expect(mocks.reset).toHaveBeenCalledOnce();
  expect(mocks.termResize).toHaveBeenCalledWith(100, 30);
  expect(mocks.write.mock.calls[1][0]).toBe('screen');
  expect(resize).not.toHaveBeenCalled();
  mocks.write.mock.calls[1][1]();
  expect(resize).toHaveBeenCalledWith(120, 40);
});

it('ignores an empty snap and skips the resize for invalid sizes', async () => {
  const { snap, resize } = await mountSnap();
  snap({ cols: 100, rows: 30, d: '' });
  expect(mocks.reset).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
  snap({ cols: 0, rows: 1.5, d: 'screen' });
  mocks.write.mock.calls[0][1]();
  expect(mocks.termResize).not.toHaveBeenCalled();
  mocks.write.mock.calls[1][1]();
  expect(resize).toHaveBeenCalledWith(80, 24);
});

it('mounts and starts without throwing when the preload has no onSnap', async () => {
  const { order } = await mountSnap(false);
  expect(order).toEqual(['start']);
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

it('orders the exit banner behind a pending snap so the snapshot cannot wipe it', async () => {
  const { snap, data, exit } = await mountSnap();
  data('x');
  snap({ cols: 100, rows: 30, d: 'screen' });
  exit();
  expect(mocks.write.mock.calls.map(c => c[0])).toEqual(['x', '']);
  mocks.write.mock.calls[1][1]();
  expect(mocks.write.mock.calls.map(c => c[0])).toEqual(['x', '', 'screen', '\r\n[process exited - press Enter to restart]\r\n']);
});
