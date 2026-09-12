import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AetherStoreProvider } from '../../state/store';
import { PtyTerminal, prepareClaudeTerminal } from './PtyTerminal';
const mocks = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; write = mocks.write;
  loadAddon() {} open() {} onData() {} onResize() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
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
  const first = render(<AetherStoreProvider><PtyTerminal /></AetherStoreProvider>);
  expect(mocks.write).toHaveBeenCalledWith('startup or replay');
  first.unmount();
  render(<AetherStoreProvider><PtyTerminal /></AetherStoreProvider>);
  expect(start).toHaveBeenCalledOnce();
});
