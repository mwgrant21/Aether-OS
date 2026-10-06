import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AetherStoreProvider } from '../../state/store';
import { PtyTerminal2 } from './PtyTerminal2';
const mocks = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; write = mocks.write;
  loadAddon() {} open() {} onData() {} onResize() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as unknown as { aetherElectron?: unknown }).aetherElectron; });
it('starts its own session once, after subscribing, and keeps it across tab remounts without touching the pinned pty', () => {
  let receive: ((value: string) => void) | undefined;
  const start = vi.fn(() => { receive?.('first output'); return Promise.resolve(); });
  const pinnedStart = vi.fn();
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: {
    pty: { start: pinnedStart, onData: () => () => {}, write() {}, resize() {} },
    terminal2Pty: { start, onData: (callback: (value: string) => void) => { receive = callback; return () => {}; }, write() {}, resize() {} },
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
