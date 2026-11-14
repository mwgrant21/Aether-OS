import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { GuiTerminal } from './GuiTerminal';

const mocks = vi.hoisted(() => ({
  data: undefined as ((input: string) => void) | undefined,
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    buffer = { active: { baseY: 0, getLine: () => undefined } };
    write = vi.fn();
    reset = vi.fn();
    dispose = vi.fn();
    loadAddon() {}
    open() {}
    onData(cb: (input: string) => void) {
      mocks.data = cb;
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

let gui: { write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; onData: ReturnType<typeof vi.fn>; onExit: ReturnType<typeof vi.fn> };
const onTyped = vi.fn();

beforeEach(() => {
  mocks.data = undefined;
  onTyped.mockClear();
  gui = { write: vi.fn(), resize: vi.fn(), onData: vi.fn(() => () => {}), onExit: vi.fn(() => () => {}) };
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: { gui } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  render(<GuiTerminal sessionKey="k1" onChunk={vi.fn()} onExit={vi.fn()} onTyped={onTyped} />);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GuiTerminal input', () => {
  it('does not forward focus reports', () => {
    mocks.data!('\x1b[I');
    mocks.data!('\x1b[O');
    expect(gui.write).not.toHaveBeenCalled();
    expect(onTyped).not.toHaveBeenCalled();
  });

  it('forwards other input unchanged', () => {
    mocks.data!('y');
    mocks.data!('\x1b[Ix');
    expect(gui.write).toHaveBeenCalledWith('k1', 'y');
    expect(gui.write).toHaveBeenCalledWith('k1', '\x1b[Ix');
    expect(onTyped).toHaveBeenCalledWith('y');
    expect(onTyped).toHaveBeenCalledWith('\x1b[Ix');
  });
});
