import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { StartResult } from '../../electron/gui/guiTypes';
import { ChatPane } from './ChatPane';

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  reset: vi.fn(),
  dispose: vi.fn(),
  fitTo: undefined as { cols: number; rows: number } | undefined,
  data: undefined as ((input: string) => void) | undefined,
  resize: undefined as ((s: { cols: number; rows: number }) => void) | undefined,
  order: [] as string[],
  screen: [] as string[],
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    buffer = {
      active: {
        viewportY: 0,
        getLine: (y: number) =>
          mocks.screen[y] === undefined ? undefined : { translateToString: () => mocks.screen[y]!, isWrapped: false },
      },
    };
    write = mocks.write;
    reset = mocks.reset;
    dispose = mocks.dispose;
    loadAddon(addon: { term?: unknown }) {
      addon.term = this;
    }
    open() {}
    onData(cb: (input: string) => void) {
      mocks.data = cb;
      return { dispose() {} };
    }
    onResize(cb: (s: { cols: number; rows: number }) => void) {
      mocks.resize = cb;
      return { dispose() {} };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    term?: { cols: number; rows: number };
    fit() {
      if (mocks.fitTo && this.term) {
        this.term.cols = mocks.fitTo.cols;
        this.term.rows = mocks.fitTo.rows;
      }
    }
  },
}));

type Cb = (d?: string) => void;
let chunk: Cb | undefined;
let exit: Cb | undefined;
let unsubData: ReturnType<typeof vi.fn>;
let unsubExit: ReturnType<typeof vi.fn>;
let gui: {
  projects: { list: ReturnType<typeof vi.fn> };
  start: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onAlive: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
};

function install(startResult: StartResult | Promise<StartResult> = { ok: true, reused: false }) {
  chunk = undefined;
  exit = undefined;
  unsubData = vi.fn();
  unsubExit = vi.fn();
  mocks.order.length = 0;
  gui = {
    projects: { list: vi.fn(() => Promise.resolve([{ id: 'p1', name: 'alpha' }])) },
    start: vi.fn(() => {
      mocks.order.push('start');
      return Promise.resolve(startResult);
    }),
    write: vi.fn(),
    resize: vi.fn(),
    submit: vi.fn(() => Promise.resolve(true)),
    onData: vi.fn((cb: Cb) => {
      mocks.order.push('onData');
      chunk = cb;
      return unsubData;
    }),
    onAlive: vi.fn(() => () => {}),
    onExit: vi.fn((cb: Cb) => {
      exit = cb;
      return unsubExit;
    }),
  };
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: { gui } });
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
const PROMPT = [
  'Accessing workspace:',
  'C:\Users\Matt',
  "Quick safety check: Is this a project you created or one you trust?",
  '> No, exit',
  '  Yes, I trust this folder',
];
const TRUST_HINT = "Answer Claude's trust prompt in the pane first";
const advance = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
  });
const box = () => screen.getByLabelText('Message') as HTMLTextAreaElement;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.write.mockClear();
  mocks.reset.mockClear();
  mocks.dispose.mockClear();
  mocks.fitTo = undefined;
  mocks.screen = [];
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
  delete (HTMLElement.prototype as unknown as { offsetWidth?: unknown }).offsetWidth;
  delete (HTMLElement.prototype as unknown as { offsetHeight?: unknown }).offsetHeight;
});

describe('ChatPane', () => {
  it('subscribes onData before start, and starts once with the project id and fitted size', async () => {
    install();
    mocks.fitTo = { cols: 100, rows: 30 };
    render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(1);
    expect(gui.start).toHaveBeenCalledWith({ projectId: 'p1', cols: 100, rows: 30 });
    expect(mocks.order).toEqual(['onData', 'start']);
    expect(screen.getByText('alpha')).toBeTruthy();
  });

  it('reports live and keeps the composer disabled until output then 1500 ms of quiet', async () => {
    install();
    const onLive = vi.fn();
    render(<ChatPane projectId={null} onLiveChange={onLive} />);
    await flush();
    expect(onLive).toHaveBeenCalledWith(true);
    expect(box().disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(box().disabled).toBe(true); // no output yet
    act(() => chunk!('hello'));
    expect(mocks.write).toHaveBeenCalledWith('hello');
    await act(async () => {
      vi.advanceTimersByTime(1400);
    });
    expect(box().disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(box().disabled).toBe(false);
  });

  it('enables the composer at the 8 s ceiling when output never goes quiet', async () => {
    install();
    render(<ChatPane projectId={null} onLiveChange={vi.fn()} />);
    await flush();
    for (let t = 0; t < 7000; t += 1000) {
      act(() => chunk!('spin'));
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(box().disabled).toBe(true);
    act(() => chunk!('spin'));
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(box().disabled).toBe(false);
  });

  it('StrictMode: start is called once, after onData, and the composer waits for the quiet window', async () => {
    install();
    gui.start
      .mockImplementationOnce(() => {
        mocks.order.push('start');
        return Promise.resolve({ ok: true, reused: false });
      })
      .mockImplementation(() => {
        mocks.order.push('start');
        return Promise.resolve({ ok: true, reused: true });
      });
    render(
      <StrictMode>
        <ChatPane projectId="p1" onLiveChange={vi.fn()} />
      </StrictMode>,
    );
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(1);
    expect(mocks.order.indexOf('onData')).toBeLessThan(mocks.order.indexOf('start'));
    expect(box().disabled).toBe(true);
    act(() => chunk!('banner'));
    await act(async () => {
      vi.advanceTimersByTime(1400);
    });
    expect(box().disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(box().disabled).toBe(false);
  });

  it('enables after the reply when the quiet timer fired before the start reply resolved', async () => {
    let reply!: (r: StartResult) => void;
    install(new Promise<StartResult>((r) => (reply = r)));
    render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    act(() => chunk!('early'));
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    expect(box().disabled).toBe(true); // not live yet
    reply({ ok: true, reused: false });
    await flush();
    expect(box().disabled).toBe(false);
  });

  it('a reused session enables the composer immediately with no chunk', async () => {
    install({ ok: true, reused: true });
    render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    expect(box().disabled).toBe(false);
  });

  it('shows the no-output hint after 15 s and keeps the composer disabled', async () => {
    install();
    render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    expect(screen.queryByText(/No output from Claude yet/)).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(15000);
    });
    expect(screen.getByText('No output from Claude yet. Type in the pane.')).toBeTruthy();
    expect(screen.queryByText('Restart')).toBeNull();
    expect(box().disabled).toBe(true);
  });

  it('submit calls gui.submit with the text', async () => {
    install({ ok: true, reused: true });
    render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    fireEvent.change(box(), { target: { value: 'do the thing' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await flush();
    expect(gui.submit).toHaveBeenCalledWith('do the thing');
  });

  it('typed xterm data goes to gui.write and resizes to gui.resize', async () => {
    install();
    render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    mocks.data!('y');
    expect(gui.write).toHaveBeenCalledWith('y');
    mocks.resize!({ cols: 90, rows: 20 });
    expect(gui.resize).toHaveBeenCalledWith(90, 20);
  });

  it.each([
    ['unavailable', 'Folder storage is not available this run'],
    ['missing-dir', 'That folder no longer exists'],
  ] as const)('start failure %s shows the reason and the composer stays disabled', async (reason, text) => {
    install({ ok: false, reason });
    const onLive = vi.fn();
    render(<ChatPane projectId="p1" onLiveChange={onLive} />);
    await flush();
    expect(screen.getByText(text)).toBeTruthy();
    expect(box().disabled).toBe(true);
    expect(onLive).toHaveBeenLastCalledWith(false);
  });

  it('onExit disables the composer and shows Restart, which starts again', async () => {
    install({ ok: true, reused: true });
    const onLive = vi.fn();
    render(<ChatPane projectId="p1" onLiveChange={onLive} />);
    await flush();
    expect(box().disabled).toBe(false);
    act(() => exit!());
    expect(mocks.write).toHaveBeenCalledWith('\r\n[process exited]\r\n');
    expect(box().disabled).toBe(true);
    expect(onLive).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByText('Restart'));
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(2);
    expect(mocks.reset).toHaveBeenCalled();
  });

  it('skips fit and sends no resize while the host is hidden', async () => {
    install();
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 0 });
    mocks.fitTo = { cols: 1, rows: 1 };
    render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    expect(gui.start).toHaveBeenCalledWith({ projectId: 'p1', cols: 80, rows: 24 });
    expect(gui.resize).not.toHaveBeenCalled();
  });

  it('unmount unsubscribes and disposes the terminal', async () => {
    install();
    const { unmount } = render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    unmount();
    expect(unsubData).toHaveBeenCalledTimes(1);
    expect(unsubExit).toHaveBeenCalledTimes(1);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });

  describe('trust prompt gate', () => {
    it('keeps the composer disabled and shows the hint while the prompt is on screen before ready', async () => {
      install();
      render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      mocks.screen = PROMPT;
      act(() => chunk!('prompt'));
      await advance(1700);
      expect(box().disabled).toBe(true);
      expect(screen.getByText(TRUST_HINT)).toBeTruthy();
    });

    it('re-enables only after the screen is clear and 1.5 s quiet', async () => {
      install();
      render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      mocks.screen = PROMPT;
      act(() => chunk!('prompt'));
      await advance(300);
      expect(screen.getByText(TRUST_HINT)).toBeTruthy();
      mocks.screen = ['> '];
      act(() => chunk!('redraw'));
      await advance(1400);
      expect(box().disabled).toBe(true);
      await advance(200);
      expect(box().disabled).toBe(false);
      expect(screen.queryByText(TRUST_HINT)).toBeNull();
    });

    it('disables the composer again when the prompt appears after the ready gate fired', async () => {
      install();
      render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      mocks.screen = ['banner'];
      act(() => chunk!('banner'));
      await advance(1700);
      expect(box().disabled).toBe(false);
      mocks.screen = PROMPT;
      act(() => chunk!('prompt'));
      await advance(300);
      expect(box().disabled).toBe(true);
      expect(screen.getByText(TRUST_HINT)).toBeTruthy();
    });

    it('stays disabled when chunks keep arriving every 200 ms for 10 s over the prompt', async () => {
      install();
      render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      mocks.screen = PROMPT;
      for (let t = 0; t < 10000; t += 200) {
        act(() => chunk!('spin'));
        await advance(200);
      }
      expect(box().disabled).toBe(true);
      expect(screen.getByText(TRUST_HINT)).toBeTruthy();
    });

    it('onExit clears the hint, and Restart starts again with it still clear', async () => {
      install();
      render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      mocks.screen = PROMPT;
      act(() => chunk!('prompt'));
      await advance(300);
      expect(screen.getByText(TRUST_HINT)).toBeTruthy();
      mocks.screen = [];
      act(() => exit!());
      expect(screen.queryByText(TRUST_HINT)).toBeNull();
      expect(screen.getByText('Restart')).toBeTruthy();
      fireEvent.click(screen.getByText('Restart'));
      expect(screen.queryByText(TRUST_HINT)).toBeNull();
      await flush();
      expect(gui.start).toHaveBeenCalledTimes(2);
    });

    it('a reused session with an empty screen is enabled immediately and shows no trust hint', async () => {
      install({ ok: true, reused: true });
      render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      await advance(300);
      expect(box().disabled).toBe(false);
      expect(screen.queryByText(TRUST_HINT)).toBeNull();
    });
  });

  describe('placeholder', () => {
    it('reads Starting Claude... before ready and Message Claude after the quiet window', async () => {
      install();
      render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      expect(box().placeholder).toBe('Starting Claude...');
      act(() => chunk!('hello'));
      await advance(1700);
      expect(box().placeholder).toBe('Message Claude');
    });

    it('reads Claude is not running after the process exits', async () => {
      install({ ok: true, reused: true });
      render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      act(() => exit!());
      expect(box().placeholder).toBe('Claude is not running');
    });

    it('reads Waiting for your answer in the pane while the trust prompt shows', async () => {
      install();
      render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      mocks.screen = PROMPT;
      act(() => chunk!('prompt'));
      await advance(300);
      expect(box().placeholder).toBe('Waiting for your answer in the pane');
    });
  });

  describe('unmount races', () => {
    it('ignores a start reply that arrives after unmount', async () => {
      let reply!: (r: StartResult) => void;
      install(new Promise<StartResult>((r) => (reply = r)));
      const onLive = vi.fn();
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { unmount } = render(<ChatPane projectId="p1" onLiveChange={onLive} />);
      await flush();
      expect(gui.start).toHaveBeenCalledTimes(1);
      unmount();
      reply({ ok: true, reused: true });
      await flush();
      expect(onLive).not.toHaveBeenCalledWith(true);
      expect(err).not.toHaveBeenCalled();
      expect(gui.write).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('never calls start when unmounted in the same tick as render', async () => {
      install();
      const { unmount } = render(<ChatPane projectId="p1" onLiveChange={vi.fn()} />);
      unmount();
      await flush();
      expect(gui.start).not.toHaveBeenCalled();
    });
  });
});
