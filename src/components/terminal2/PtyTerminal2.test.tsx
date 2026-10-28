import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AetherStoreProvider } from '../../state/store';
import { PtyTerminal2 } from './PtyTerminal2';
const mocks = vi.hoisted(() => ({ write: vi.fn(), reset: vi.fn(), data: undefined as ((input: string) => void) | undefined }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; write = mocks.write; reset = mocks.reset;
  loadAddon() {} open() {} onData(cb: (input: string) => void) { mocks.data = cb; } onResize() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as unknown as { aetherElectron?: unknown }).aetherElectron; });
it('starts its own session once, after subscribing, and keeps it across tab remounts without touching the pinned pty', () => {
  let receive: ((value: string) => void) | undefined;
  const start = vi.fn(() => { receive?.('first output'); return Promise.resolve(); });
  const pinnedStart = vi.fn();
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: {
    pty: { start: pinnedStart, onData: () => () => {}, write() {}, resize() {} },
    terminal2Pty: { start, onData: (callback: (value: string) => void) => { receive = callback; return () => {}; }, onExit: () => () => {}, write() {}, resize() {} },
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

it('restarts an exited session only on Enter and drops other input meanwhile', async () => {
  vi.resetModules();
  mocks.write.mockClear();
  let exit: (() => void) | undefined;
  const start = vi.fn(() => Promise.resolve());
  const ptyWrite = vi.fn();
  const pinnedStart = vi.fn();
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: {
    pty: { start: pinnedStart, onData: () => () => {}, write() {}, resize() {} },
    terminal2Pty: { start, onData: () => () => {}, onExit: (cb: () => void) => { exit = cb; return () => {}; }, write: ptyWrite, resize() {} },
  } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const { AetherStoreProvider: Provider } = await import('../../state/store');
  const { PtyTerminal2: Fresh } = await import('./PtyTerminal2');
  render(<Provider><Fresh /></Provider>);
  expect(start).toHaveBeenCalledOnce();
  mocks.data!('a');
  expect(ptyWrite).toHaveBeenCalledWith('a');
  exit!();
  expect(mocks.write).toHaveBeenCalledWith('\r\n[process exited - press Enter to restart]\r\n');
  mocks.data!('x');
  expect(start).toHaveBeenCalledOnce();
  expect(ptyWrite).not.toHaveBeenCalledWith('x');
  mocks.data!('\r');
  expect(mocks.reset).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenLastCalledWith({ cols: 80, rows: 24 });
  expect(pinnedStart).not.toHaveBeenCalled();
});
