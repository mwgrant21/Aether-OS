import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { AetherStoreProvider } from '../../state/store';
import { PtyTerminal2 } from './PtyTerminal2';
const mocks = vi.hoisted(() => ({ write: vi.fn(), reset: vi.fn(), data: undefined as ((input: string) => void) | undefined, paste: vi.fn(), hasSelection: vi.fn(() => false), getSelection: vi.fn(() => ''), key: undefined as ((ev: KeyboardEvent) => boolean) | undefined }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; write = mocks.write; reset = mocks.reset;
  hasSelection = mocks.hasSelection; getSelection = mocks.getSelection; paste = mocks.paste;
  attachCustomKeyEventHandler(cb: (ev: KeyboardEvent) => boolean) { mocks.key = cb; }
  loadAddon() {} open() {} onData(cb: (input: string) => void) { mocks.data = cb; } onResize() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as unknown as { aetherElectron?: unknown }).aetherElectron; delete (navigator as unknown as { clipboard?: unknown }).clipboard; });
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

async function mountFresh() {
  vi.resetModules();
  mocks.paste.mockClear();
  const ptyWrite = vi.fn();
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: {
    terminal2Pty: { start: vi.fn(() => Promise.resolve()), onData: () => () => {}, onExit: () => () => {}, write: ptyWrite, resize() {} },
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
  mocks.hasSelection.mockReturnValue(false);
  fireEvent.mouseDown(host);
  fireEvent.mouseUp(document);
  expect(writeText).toHaveBeenCalledOnce();
});

it('pastes clipboard text on Ctrl+V and Ctrl+Shift+V through xterm paste and swallows the key, leaving Ctrl+C alone', async () => {
  stubClipboard(vi.fn(() => Promise.resolve('abc')), vi.fn());
  const { ptyWrite } = await mountFresh();
  const key = (init: Partial<KeyboardEvent>) => ({ type: 'keydown', ctrlKey: true, altKey: false, metaKey: false, preventDefault: vi.fn(), ...init }) as unknown as KeyboardEvent;
  const v = key({ key: 'v' });
  expect(mocks.key!(v)).toBe(false);
  expect(v.preventDefault).toHaveBeenCalled();
  await Promise.resolve(); await Promise.resolve();
  expect(mocks.paste).toHaveBeenCalledWith('abc');
  expect(mocks.key!(key({ key: 'V', shiftKey: true }))).toBe(false);
  await Promise.resolve(); await Promise.resolve();
  expect(mocks.paste).toHaveBeenCalledTimes(2);
  expect(mocks.key!(key({ key: 'v', type: 'keyup' }))).toBe(false);
  expect(mocks.key!(key({ key: 'c' }))).toBe(true);
  await Promise.resolve(); await Promise.resolve();
  expect(mocks.paste).toHaveBeenCalledTimes(2);
  expect(ptyWrite).not.toHaveBeenCalled();
});
