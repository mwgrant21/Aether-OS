import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { AetherStoreProvider } from '../../state/store';
import { PtyTerminal, prepareClaudeTerminal, focusClaudeTerminal } from './PtyTerminal';
const mocks = vi.hoisted(() => ({ write: vi.fn(), focus: vi.fn() }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; write = mocks.write; focus = mocks.focus;
  loadAddon() {} open() {} onData() {} onResize() {}
} }));
const markers = vi.hoisted(() => { const setEnabled = vi.fn(); return { setEnabled, attach: vi.fn(() => ({ setEnabled, flush() {}, dispose() {} })) }; });
vi.mock('./terminalMarkerDecorations', () => ({ attachTerminalMarkers: markers.attach }));
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
