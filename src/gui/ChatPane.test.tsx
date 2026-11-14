import { StrictMode, useState, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { StartResult } from '../../electron/gui/guiTypes';
import { ChatPane, type ChatPaneStatus } from './ChatPane';

const flags = vi.hoisted(() => ({ markerReliable: true }));
vi.mock('./busyGate', async (orig) => {
  const m = await orig<typeof import('./busyGate')>();
  return { ...m, get GUI_BG_MARKER_RELIABLE() { return flags.markerReliable; } };
});

// ChatPane's mode is controlled: the harness plays GuiApp's part and keeps it in state.
const onStatus = vi.fn<(s: ChatPaneStatus) => void>();
type PaneProps = Partial<ComponentProps<typeof ChatPane>> & { projectId: string | null };
function Pane({ mode: initialMode, onModeChange, ...p }: PaneProps) {
  const [mode, setMode] = useState(initialMode ?? 'auto');
  return (
    <ChatPane
      active
      onStatus={onStatus}
      {...p}
      mode={mode}
      onModeChange={(m) => {
        setMode(m);
        onModeChange?.(m);
      }}
    />
  );
}

const lastStatus = (): ChatPaneStatus => onStatus.mock.calls.at(-1)![0];

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  reset: vi.fn(),
  dispose: vi.fn(),
  fitTo: undefined as { cols: number; rows: number } | undefined,
  fits: 0,
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
        baseY: 0,
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
      mocks.fits += 1;
      if (mocks.fitTo && this.term) {
        this.term.cols = mocks.fitTo.cols;
        this.term.rows = mocks.fitTo.rows;
      }
    }
  },
}));

type Cb = (key: string, d?: string) => void;
let dataCb: Cb | undefined;
let exitCb: Cb | undefined;
// The key the pane under test speaks for: its start request names the project (null = New chat).
const paneKey = (): string => (gui.start.mock.calls.at(-1)?.[0] as { projectId: string | null } | undefined)?.projectId ?? 'new';
const chunk = ((d?: string, key?: string) => dataCb!(key ?? paneKey(), d)) as ((d?: string, key?: string) => void) | undefined;
const exit = ((key?: string) => exitCb!(key ?? paneKey())) as ((key?: string) => void) | undefined;
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
  dataCb = undefined;
  exitCb = undefined;
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
      dataCb = cb;
      return unsubData;
    }),
    onAlive: vi.fn(() => () => {}),
    onExit: vi.fn((cb: Cb) => {
      exitCb = cb;
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
  'C:\\Users\\Matt',
  "Quick safety check: Is this a project you created or one you trust?",
  '> No, exit',
  '  Yes, I trust this folder',
];
// Claude Code 2.1.323 idle box, rows 25-30 of the saved 100x30 screen (built from escapes).
const RULE = '\u2500'.repeat(100);
const BOX_SCREEN = [
  ' '.repeat(82) + '\u25cf high \u00b7 /effort',
  RULE,
  '\u276f\u00a0Try "write a test for <filepath>"',
  RULE,
  '',
  '  \u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 \u2190 1 agent',
];
// The bare PowerShell launch screen: no input box yet.
const PS_ONLY = [
  'Windows PowerShell',
  'Copyright (C) Microsoft Corporation. All rights reserved.',
  '',
  'PS C:\\Users\\Matt\\.aether-os\\gui-chat> Remove-Item Env:\\ANTHROPIC_API_KEY -ErrorAction SilentlyContin',
  'ue; Remove-Item Env:\\ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue; Remove-Item Env:\\ANTHROPIC_',
  'BASE_URL -ErrorAction SilentlyContinue',
  'PS C:\\Users\\Matt\\.aether-os\\gui-chat> Remove-Item Env:\\CLAUDE_CODE_CHILD_SESSION -ErrorAction Silent',
  'lyContinue; claude --session-id 07faf54b-30fb-4fa7-90a5-ffab1e033c38 --permission-mode auto; exit',
];
const TRUST_HINT = "Answer Claude's trust prompt in the pane first";
const advance = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
  });
const box = () => screen.getByLabelText('Message') as HTMLTextAreaElement;

beforeEach(() => {
  onStatus.mockClear();
  flags.markerReliable = true;
  vi.useFakeTimers();
  mocks.write.mockClear();
  mocks.reset.mockClear();
  mocks.dispose.mockClear();
  mocks.fitTo = undefined;
  mocks.fits = 0;
  mocks.screen = BOX_SCREEN;
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
    render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(1);
    expect(gui.start).toHaveBeenCalledWith({ projectId: 'p1', cols: 100, rows: 30, mode: 'auto' });
    expect(mocks.order).toEqual(['onData', 'start']);
    expect(screen.getByText('alpha')).toBeTruthy();
  });

  it('reports live and keeps the composer disabled until output then 1500 ms of quiet', async () => {
    install();
    const onLive = vi.fn();
    render(<Pane projectId={null} onLiveChange={onLive} />);
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
    render(<Pane projectId={null} onLiveChange={vi.fn()} />);
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
        <Pane projectId="p1" onLiveChange={vi.fn()} />
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
    render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
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

  it('a normal first start is sent without restart and enables after the quiet window', async () => {
    install();
    render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(1);
    expect(gui.start.mock.calls[0]![0]).not.toHaveProperty('restart');
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(box().disabled).toBe(true);
    act(() => chunk!('hello'));
    await advance(1700);
    expect(box().disabled).toBe(false);
  });

  it('a reused start restarts the session once and the composer waits for the ready gate on the new one', async () => {
    install();
    gui.start
      .mockImplementationOnce(() => Promise.resolve({ ok: true, reused: true }))
      .mockImplementation(() => Promise.resolve({ ok: true, reused: false }));
    render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(2);
    expect(gui.start.mock.calls[1]![0]).toEqual({ projectId: 'p1', cols: 80, rows: 24, mode: 'auto', restart: true });
    expect(mocks.reset).toHaveBeenCalledTimes(1);
    expect(box().disabled).toBe(true); // not forced ready
    await advance(5000);
    expect(box().disabled).toBe(true);
    act(() => chunk!('banner'));
    await advance(1700);
    expect(box().disabled).toBe(false);
  });

  it('a chunk between the reused reply and the restart reply is dropped: not written, gate not fed', async () => {
    let replyRestart!: (r: StartResult) => void;
    install();
    gui.start
      .mockImplementationOnce(() => Promise.resolve({ ok: true, reused: true }))
      .mockImplementation(() => new Promise<StartResult>((r) => (replyRestart = r)));
    render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(2);
    mocks.write.mockClear();
    act(() => chunk!('old-pty-tail'));
    await advance(5000);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(box().disabled).toBe(true); // gate was not fed, so not ready
    replyRestart({ ok: true, reused: false });
    await flush();
    act(() => chunk!('new banner'));
    expect(mocks.write).toHaveBeenCalledWith('new banner');
    await advance(1700);
    expect(box().disabled).toBe(false);
  });

  it('a second reused answer does not restart again, keeps the composer disabled and shows the hint', async () => {
    install({ ok: true, reused: true });
    render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    await flush();
    await advance(16000);
    expect(gui.start).toHaveBeenCalledTimes(2);
    expect(box().disabled).toBe(true);
    expect(screen.getByText('No output from Claude yet. Type in the pane.')).toBeTruthy();
  });

  it('shows the no-output hint after 15 s and keeps the composer disabled', async () => {
    install();
    render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
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
    install();
    render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    act(() => chunk!('hello'));
    await advance(1700);
    fireEvent.change(box(), { target: { value: 'do the thing' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await flush();
    expect(gui.submit).toHaveBeenCalledWith('p1', 'do the thing');
  });

  it('typed xterm data goes to gui.write and resizes to gui.resize', async () => {
    install();
    render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    mocks.data!('y');
    expect(gui.write).toHaveBeenCalledWith('p1', 'y');
    mocks.resize!({ cols: 90, rows: 20 });
    expect(gui.resize).toHaveBeenCalledWith('p1', 90, 20);
  });

  it('write, resize and submit of the New chat carry the new key', async () => {
    install();
    render(<Pane projectId={null} onLiveChange={vi.fn()} />);
    await flush();
    act(() => chunk!('hello'));
    await advance(1600);
    mocks.data!('y');
    mocks.resize!({ cols: 90, rows: 20 });
    expect(gui.write).toHaveBeenCalledWith('new', 'y');
    expect(gui.resize).toHaveBeenCalledWith('new', 90, 20);
    fireEvent.change(box(), { target: { value: 'hi' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await flush();
    expect(gui.submit).toHaveBeenCalledWith('new', 'hi');
  });

  it('ignores data and exit events for another key', async () => {
    install();
    render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    act(() => chunk!('other chat output', 'p2'));
    expect(mocks.write).not.toHaveBeenCalledWith('other chat output');
    await advance(2000);
    expect(box().disabled).toBe(true); // the foreign chunk did not feed the ready gate
    act(() => exit!('p2'));
    expect(screen.queryByText('Restart')).toBeNull();
    expect(mocks.write).not.toHaveBeenCalledWith('\r\n[process exited]\r\n');
    act(() => chunk!('mine'));
    expect(mocks.write).toHaveBeenCalledWith('mine');
  });

  it('too-many-live shows its text and Restart', async () => {
    install({ ok: false, reason: 'too-many-live' });
    render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    expect(screen.getByText('Too many chats are working. Wait for one to finish.')).toBeTruthy();
    expect(screen.getByText('Restart')).toBeTruthy();
  });

  it('a superseded start reply is a no-op: no error, no Restart', async () => {
    install({ ok: false, reason: 'superseded' });
    const onLive = vi.fn();
    render(<Pane projectId="p1" onLiveChange={onLive} />);
    await flush();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText('Restart')).toBeNull();
    expect(onLive).not.toHaveBeenCalledWith(false);
  });

  it.each([
    ['unavailable', 'Folder storage is not available this run'],
    ['missing-dir', 'That folder no longer exists'],
  ] as const)('start failure %s shows the reason and the composer stays disabled', async (reason, text) => {
    install({ ok: false, reason });
    const onLive = vi.fn();
    render(<Pane projectId="p1" onLiveChange={onLive} />);
    await flush();
    expect(screen.getByText(text)).toBeTruthy();
    expect(box().disabled).toBe(true);
    expect(onLive).toHaveBeenLastCalledWith(false);
  });

  it('onExit disables the composer and shows Restart, which starts again', async () => {
    install();
    const onLive = vi.fn();
    render(<Pane projectId="p1" onLiveChange={onLive} />);
    await flush();
    act(() => chunk!('hello'));
    await advance(1700);
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
    render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    expect(gui.start).toHaveBeenCalledWith({ projectId: 'p1', cols: 80, rows: 24, mode: 'auto' });
    expect(gui.resize).not.toHaveBeenCalled();
  });

  it('unmount unsubscribes and disposes the terminal', async () => {
    install();
    const { unmount } = render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    unmount();
    expect(unsubData).toHaveBeenCalledTimes(1);
    expect(unsubExit).toHaveBeenCalledTimes(1);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });

  describe('trust prompt gate', () => {
    it('keeps the composer disabled and shows the hint while the prompt is on screen before ready', async () => {
      install();
      render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      mocks.screen = PROMPT;
      act(() => chunk!('prompt'));
      await advance(1700);
      expect(box().disabled).toBe(true);
      expect(screen.getByText(TRUST_HINT)).toBeTruthy();
    });

    it('re-enables only after the screen is clear and 1.5 s quiet', async () => {
      install();
      render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      mocks.screen = PROMPT;
      act(() => chunk!('prompt'));
      await advance(300);
      expect(screen.getByText(TRUST_HINT)).toBeTruthy();
      mocks.screen = BOX_SCREEN;
      act(() => chunk!('redraw'));
      await advance(1400);
      expect(box().disabled).toBe(true);
      await advance(200);
      expect(box().disabled).toBe(false);
      expect(screen.queryByText(TRUST_HINT)).toBeNull();
    });

    it('disables the composer again when the prompt appears after the ready gate fired', async () => {
      install();
      render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      mocks.screen = BOX_SCREEN;
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
      render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
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
      render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
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

  });

  describe('placeholder', () => {
    it('reads Starting Claude... before ready and Message Claude after the quiet window', async () => {
      install();
      render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      expect(box().placeholder).toBe('Starting Claude...');
      act(() => chunk!('hello'));
      await advance(1700);
      expect(box().placeholder).toBe('Message Claude');
    });

    it('reads Claude is not running after the process exits', async () => {
      install();
      render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      act(() => exit!());
      expect(box().placeholder).toBe('Claude is not running');
    });

    it('reads Waiting for your answer in the pane while the trust prompt shows', async () => {
      install();
      render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      mocks.screen = PROMPT;
      act(() => chunk!('prompt'));
      await advance(300);
      expect(box().placeholder).toBe('Waiting for your answer in the pane');
    });
  });

  describe('input box gate', () => {
    it('keeps the composer disabled after the ready gate fires on the bare PowerShell screen, until two polls see the box', async () => {
      install();
      render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      mocks.screen = PS_ONLY;
      act(() => chunk!('hello'));
      await advance(1700);
      expect(box().disabled).toBe(true);
      expect(box().placeholder).toBe('Starting Claude...');
      mocks.screen = BOX_SCREEN;
      await advance(250);
      expect(box().disabled).toBe(true);
      await advance(250);
      expect(box().disabled).toBe(false);
    });

    it('enables at the 8 s ceiling when the box never shows and the stream goes quiet', async () => {
      install();
      render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      mocks.screen = PS_ONLY;
      act(() => chunk!('hello'));
      await advance(7999);
      expect(box().disabled).toBe(true);
      await advance(1);
      expect(box().disabled).toBe(false);
    });

    it('enables at the 8 s ceiling on a stream that never goes quiet, with no box on screen', async () => {
      install();
      render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      mocks.screen = PS_ONLY;
      for (let t = 0; t < 7000; t += 1000) {
        act(() => chunk!('spin'));
        await advance(1000);
      }
      act(() => chunk!('spin'));
      await advance(999);
      expect(box().disabled).toBe(true);
      await advance(1);
      expect(box().disabled).toBe(false);
    });

    it('keeps the composer disabled over the trust prompt even with the box on screen, then enables after the clear', async () => {
      install();
      render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      mocks.screen = [...PROMPT, ...BOX_SCREEN];
      act(() => chunk!('prompt'));
      await advance(1700);
      expect(box().disabled).toBe(true);
      expect(screen.getByText(TRUST_HINT)).toBeTruthy();
      mocks.screen = BOX_SCREEN;
      act(() => chunk!('redraw'));
      await advance(1400);
      expect(box().disabled).toBe(true);
      await advance(200);
      expect(box().disabled).toBe(false);
    });

    it('waits for the new start\'s box again after exit and Restart', async () => {
      install();
      render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
      await flush();
      act(() => chunk!('hello'));
      await advance(1700);
      expect(box().disabled).toBe(false);
      mocks.screen = PS_ONLY;
      act(() => exit!());
      fireEvent.click(screen.getByText('Restart'));
      await flush();
      act(() => chunk!('hello'));
      await advance(1700);
      expect(box().disabled).toBe(true);
      mocks.screen = BOX_SCREEN;
      await advance(500);
      expect(box().disabled).toBe(false);
    });

    it('a resumed pane showing history but no box stays disabled until the box is drawn', async () => {
      install();
      render(<Pane projectId="p1" resume onLiveChange={vi.fn()} />);
      await flush();
      const history = ['Claude Code v2.1.325', '❯ earlier prompt', '● earlier answer', ''];
      mocks.screen = history;
      act(() => chunk!('history'));
      await advance(1700);
      expect(box().disabled).toBe(true);
      mocks.screen = [...history, ...BOX_SCREEN];
      await advance(500);
      expect(box().disabled).toBe(false);
    });
  });

  describe('unmount races', () => {
    it('ignores a start reply that arrives after unmount', async () => {
      let reply!: (r: StartResult) => void;
      install(new Promise<StartResult>((r) => (reply = r)));
      const onLive = vi.fn();
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { unmount } = render(<Pane projectId="p1" onLiveChange={onLive} />);
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

    it('never calls start when unmounted before the deferred start microtask runs', async () => {
      install();
      const { unmount } = render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
      unmount();
      await flush();
      expect(gui.start).not.toHaveBeenCalled();
    });
  });
});

describe('ChatPane permission mode', () => {
  const picker = (label: string) => screen.getByLabelText(`Permission mode: ${label}`);
  const ready = async () => {
    install();
    render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    act(() => chunk!('hello'));
    await advance(1700);
  };
  const send = async (text = 'go') => {
    fireEvent.change(box(), { target: { value: text } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await flush();
    await advance(3100); // quiet window: the reply "ended" (the mocked screen is the idle box screen)
  };
  const choose = (from: string, to: string) => {
    fireEvent.click(picker(from));
    fireEvent.click(screen.getByText(`● ${to}`));
  };

  it('shows Auto by default and lists the four modes', async () => {
    await ready();
    expect(picker('Auto').textContent).toBe('● Auto ▾');
    fireEvent.click(picker('Auto'));
    expect(screen.getAllByRole('menuitem').map((e) => e.textContent)).toEqual(['● Manual', '● Accept edits', '● Plan', '● Auto']);
  });

  it('is disabled with the busy hint while a turn is working and enabled after the quiet window', async () => {
    await ready();
    expect(picker('Auto').getAttribute('aria-disabled')).toBe('false');
    fireEvent.change(box(), { target: { value: 'go' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await flush();
    expect(picker('Auto').getAttribute('aria-disabled')).toBe('true');
    expect(picker('Auto').getAttribute('title')).toBe('Wait for the reply to finish');
    await advance(3100);
    expect(picker('Auto').getAttribute('aria-disabled')).toBe('false');
  });

  it('an Enter typed in the pane also counts as a turn', async () => {
    await ready();
    act(() => mocks.data!('hi\r'));
    expect(picker('Auto').getAttribute('aria-disabled')).toBe('true');
  });

  it('a real message typed within 1.5 s of answering the trust prompt counts as a turn', async () => {
    await ready();
    mocks.screen = PROMPT;
    act(() => chunk!('prompt'));
    await advance(300);
    act(() => mocks.data!('\r')); // answers the dialog
    expect(lastStatus().hasSent).toBe(false);
    mocks.screen = BOX_SCREEN;
    act(() => chunk!('redraw'));
    await advance(300); // the watcher is still shown (needs 1.5 s of silence)
    act(() => mocks.data!('hello\r'));
    expect(lastStatus().hasSent).toBe(true);
  });

  it('the Enter that answers the trust prompt is not a turn', async () => {
    await ready();
    mocks.screen = PROMPT;
    act(() => chunk!('prompt'));
    await advance(300);
    expect(screen.getByText(TRUST_HINT)).toBeTruthy();
    act(() => mocks.data!('\x1b[B'));
    act(() => mocks.data!('\r'));
    expect(lastStatus().hasSent).toBe(false);
  });

  it('selecting a mode shows the popup with the exact sentence and never the word will', async () => {
    await ready();
    choose('Auto', 'Plan');
    const text = screen.getByRole('dialog').textContent!;
    expect(text).toContain("Switch to Plan? Claude restarts and may re-read this thread's context.");
    expect(text).not.toContain('will');
  });

  it('Cancel and Esc start nothing, and Cancel holds the focus', async () => {
    await ready();
    choose('Auto', 'Plan');
    expect(document.activeElement).toBe(screen.getByText('Cancel'));
    fireEvent.click(screen.getByText('Cancel'));
    choose('Auto', 'Manual');
    fireEvent.keyDown(document, { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(gui.start).toHaveBeenCalledTimes(1);
    expect(picker('Auto')).toBeTruthy();
  });

  it('selecting the current mode is a no-op', async () => {
    await ready();
    choose('Auto', 'Auto');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(gui.start).toHaveBeenCalledTimes(1);
  });

  it('Switch relaunches fresh when nothing was sent, and the label follows once ready', async () => {
    await ready();
    choose('Auto', 'Plan');
    fireEvent.click(screen.getByText('Switch'));
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(2);
    expect(gui.start.mock.calls[1]![0]).toEqual({ projectId: 'p1', cols: 80, rows: 24, mode: 'plan', restart: true, resume: false });
    expect(mocks.reset).toHaveBeenCalled();
    expect(picker('Plan')).toBeTruthy();
    act(() => chunk!('banner'));
    await advance(1700);
    expect(picker('Plan').getAttribute('aria-disabled')).toBe('false');
  });

  it('Switch resumes after a message was sent', async () => {
    await ready();
    await send();
    choose('Auto', 'Manual');
    fireEvent.click(screen.getByText('Switch'));
    await flush();
    expect(gui.start.mock.calls[1]![0]).toMatchObject({ restart: true, resume: true, mode: 'manual' });
  });

  it('drops a chunk between Switch and the start reply, and feeds the gate only after the reply', async () => {
    let reply!: (r: StartResult) => void;
    await ready();
    gui.start.mockImplementationOnce(() => new Promise<StartResult>((r) => (reply = r)));
    choose('Auto', 'Plan');
    fireEvent.click(screen.getByText('Switch'));
    await flush();
    mocks.write.mockClear();
    act(() => chunk!('old-pty-tail'));
    await advance(5000);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(box().disabled).toBe(true);
    reply({ ok: true, reused: false });
    await flush();
    act(() => chunk!('new banner'));
    expect(mocks.write).toHaveBeenCalledWith('new banner');
  });

  it('exit before ready after a switch reverts the label, shows the error, and Restart resumes with the previous mode', async () => {
    await ready();
    await send();
    choose('Auto', 'Plan');
    fireEvent.click(screen.getByText('Switch'));
    await flush();
    act(() => exit!());
    expect(picker('Auto')).toBeTruthy();
    expect(screen.getByText('Could not switch to Plan; staying on Auto')).toBeTruthy();
    fireEvent.click(screen.getByText('Restart'));
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(3);
    expect(gui.start.mock.calls[2]![0]).toEqual({ projectId: 'p1', cols: 80, rows: 24, mode: 'auto', resume: true });
  });

  it('a Switch confirmed after a reply started does nothing', async () => {
    await ready();
    choose('Auto', 'Plan');
    fireEvent.change(box(), { target: { value: 'go' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await flush();
    fireEvent.click(screen.getByText('Switch'));
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a second failed resume makes Restart start fresh', async () => {
    await ready();
    await send();
    choose('Auto', 'Plan');
    fireEvent.click(screen.getByText('Switch'));
    await flush();
    act(() => exit!()); // failure 1 (the switch)
    fireEvent.click(screen.getByText('Restart')); // resume:true
    await flush();
    act(() => exit!()); // failure 2 (the resume)
    fireEvent.click(screen.getByText('Restart'));
    await flush();
    expect(gui.start.mock.calls[2]![0]).toMatchObject({ resume: true });
    expect(gui.start.mock.calls[3]![0]).toMatchObject({ resume: false, mode: 'auto' });
    act(() => chunk!('banner'));
    await advance(1700);
    choose('Auto', 'Manual');
    fireEvent.click(screen.getByText('Switch'));
    await flush();
    expect(gui.start.mock.calls[4]![0]).toMatchObject({ restart: true, resume: false, mode: 'manual' });
  });
});

describe('ChatPane as one of several panes', () => {
  it('reports live, state, hasSent and settled through onStatus', async () => {
    install();
    render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    expect(onStatus.mock.calls.at(-1)![0]).toEqual({ live: true, state: 'idle', trusted: true, hasSent: false, settled: false });
    act(() => chunk!('hello'));
    await advance(1700);
    fireEvent.change(box(), { target: { value: 'go' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await flush();
    expect(onStatus.mock.calls.at(-1)![0]).toMatchObject({ state: 'working', hasSent: true, settled: false });
    await advance(3100);
    expect(onStatus.mock.calls.at(-1)![0]).toMatchObject({ state: 'idle', hasSent: true });
    await advance(3100);
    expect(onStatus.mock.calls.at(-1)![0]).toMatchObject({ state: 'idle', settled: true });
  });

  it('the first start passes resume and the controlled mode; a resumed pane already holds a conversation', async () => {
    install();
    render(<Pane projectId="p1" resume mode="plan" onLiveChange={vi.fn()} />);
    await flush();
    expect(gui.start.mock.calls[0]![0]).toEqual({ projectId: 'p1', cols: 80, rows: 24, mode: 'plan', resume: true });
    expect(onStatus.mock.calls.at(-1)![0]).toMatchObject({ hasSent: true });
  });

  it('a hidden pane stays mounted and keeps absorbing output; toggling it hidden then shown never fits a 0-size host', async () => {
    install();
    let size = 800;
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => size });
    let observed: (() => void) | undefined;
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { observed = cb; } observe() {} disconnect() {} });
    const { rerender } = render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    const fitsShown = mocks.fits;
    size = 0;
    rerender(<Pane projectId="p1" active={false} onLiveChange={vi.fn()} />);
    act(() => observed!());
    expect(screen.getByTestId('chat-pane').style.display).toBe('none');
    expect(mocks.fits).toBe(fitsShown); // no fit while the host measures 0x0
    act(() => chunk!('while hidden'));
    expect(mocks.write).toHaveBeenCalledWith('while hidden');
    size = 800;
    rerender(<Pane projectId="p1" active onLiveChange={vi.fn()} />);
    act(() => observed!());
    expect(mocks.fits).toBe(fitsShown + 1);
    expect(screen.getByTestId('chat-pane').style.display).toBe('flex');
    expect(gui.resize).not.toHaveBeenCalled();
  });
});

describe('ChatPane auto-stop off', () => {
  const NOTICE = "Auto-stop is off: Aether could not recognise Claude's working screen.";
  const send = async () => {
    fireEvent.change(box(), { target: { value: 'go' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await flush();
  };
  const start = async (props: Partial<ComponentProps<typeof ChatPane>> = {}) => {
    install();
    const onStopChat = vi.fn();
    render(<Pane projectId="p1" onStopChat={onStopChat} {...props} />);
    await flush();
    act(() => chunk!('hello'));
    await advance(1700);
    return onStopChat;
  };
  // The canary: output for over 4 s of a turn with every screen read idle (the mocked screen is the idle box screen).
  const blind = async () => {
    for (let i = 0; i < 6; i++) {
      act(() => chunk!('spin'));
      await advance(1000);
    }
  };

  it('shows the notice and Stop chat after the canary fires on a chat that sent a turn; Stop chat calls onStopChat', async () => {
    const onStopChat = await start();
    expect(screen.queryByText('Stop chat')).toBeNull(); // nothing sent yet
    await send();
    expect(screen.queryByText('Stop chat')).toBeNull(); // auto-stop still on
    await blind();
    expect(screen.getByText(NOTICE)).toBeTruthy();
    expect(lastStatus().trusted).toBe(false);
    fireEvent.click(screen.getByText('Stop chat'));
    expect(onStopChat).toHaveBeenCalledTimes(1);
  });

  it('with no reliable background marker Stop chat shows on a chat that sent a turn, without the canary notice', async () => {
    flags.markerReliable = false;
    await start();
    expect(screen.queryByText('Stop chat')).toBeNull();
    await send();
    expect(screen.getByText('Stop chat')).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('a resumed pane (already holds a conversation) shows Stop chat when auto-stop is off; a never-used one does not', async () => {
    flags.markerReliable = false;
    await start({ resume: true });
    expect(screen.getByText('Stop chat')).toBeTruthy();
    cleanup();
    await start();
    expect(screen.queryByText('Stop chat')).toBeNull();
  });

  it('a chunk between the idle read and the settle window delays settled', async () => {
    await start();
    await send();
    await advance(3100); // quiet: idle read
    expect(lastStatus().settled).toBe(false);
    await advance(2000);
    act(() => chunk!('late'));
    await advance(2000); // 4 s after idle but only 2 s after the last chunk
    expect(lastStatus().settled).toBe(false);
    await advance(1100);
    expect(lastStatus().settled).toBe(true);
  });
});

describe('ChatPane Start fresh and resume fallback', () => {
  const SENTENCE = "Start a fresh conversation? The current one stays in Claude's history; this window will not reopen it.";
  const NOTE = 'Could not resume the previous conversation; started a new one.';
  const startPane = async (props: Partial<ComponentProps<typeof ChatPane>> & { projectId?: string | null } = {}) => {
    install();
    render(<Pane {...props} projectId={props.projectId === undefined ? null : props.projectId} onLiveChange={vi.fn()} />);
    await flush();
    act(() => chunk!('hello'));
    await advance(1700);
  };
  const send = async () => {
    fireEvent.change(box(), { target: { value: 'go' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await flush();
  };

  it('shows Start fresh on the New chat only', async () => {
    await startPane();
    expect(screen.getByText('Start fresh')).toBeTruthy();
    cleanup();
    await startPane({ projectId: 'p1' });
    expect(screen.queryByText('Start fresh')).toBeNull();
  });

  it('is disabled with the hint while a reply is working', async () => {
    await startPane();
    const btn = screen.getByText('Start fresh') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await send();
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('title')).toBe('Wait for the reply to finish');
    await advance(3100);
    expect(btn.disabled).toBe(false);
  });

  it('opens the popup with the exact sentence, and Cancel starts nothing', async () => {
    await startPane();
    fireEvent.click(screen.getByText('Start fresh'));
    expect(screen.getByRole('dialog').textContent).toContain(SENTENCE);
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(gui.start).toHaveBeenCalledTimes(1);
  });

  it('the Start fresh popup focuses its confirm button so Enter confirms', async () => {
    await startPane();
    fireEvent.click(screen.getByText('Start fresh'));
    expect(document.activeElement).toBe(within(screen.getByRole('dialog')).getByText('Start fresh'));
  });

  it('confirming restarts without resume, keeps the mode, and the pane reports no conversation', async () => {
    await startPane({ mode: 'plan' });
    await send();
    await advance(3100);
    expect(lastStatus().hasSent).toBe(true);
    fireEvent.click(screen.getByText('Start fresh'));
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Start fresh'));
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(2);
    expect(gui.start.mock.calls[1]![0]).toEqual({ projectId: null, cols: 80, rows: 24, mode: 'plan', restart: true, resume: false });
    expect(mocks.reset).toHaveBeenCalled();
    expect(lastStatus().hasSent).toBe(false);
  });

  it('a resume start that exits before ready is retried once without resume, shows the note, and does not loop', async () => {
    install();
    render(<Pane projectId="p1" resume mode="plan" onLiveChange={vi.fn()} />);
    await flush();
    expect(gui.start.mock.calls[0]![0]).toMatchObject({ resume: true, mode: 'plan' });
    act(() => exit!());
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(2);
    expect(gui.start.mock.calls[1]![0]).toEqual({ projectId: 'p1', cols: 80, rows: 24, mode: 'plan', restart: true, resume: false });
    expect(screen.getByText(NOTE)).toBeTruthy();
    expect(lastStatus().hasSent).toBe(false);
    act(() => exit!()); // the retry fails too: the normal exit state, no third start
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Restart')).toBeTruthy();
  });

  it('a non-resume start that exits before ready is not retried', async () => {
    install();
    render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    act(() => exit!());
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Restart')).toBeTruthy();
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  const choose = (from: string, to: string) => {
    fireEvent.click(screen.getByLabelText(`Permission mode: ${from}`));
    fireEvent.click(screen.getByText(`● ${to}`));
  };
  // The live shape: the pty is a shell, so the ready gate can fire on shell quiet if claude prints its error later.
  const resumeDiesAfterGate = async (props: { projectId: string | null }) => {
    install();
    render(<Pane projectId={props.projectId} resume mode="plan" onLiveChange={vi.fn()} />);
    await flush();
    act(() => chunk!('Windows PowerShell'));
    await advance(1700);
    expect(box().disabled).toBe(false);
    act(() => chunk!('\x1b[0mNo conversation found to continue\r\n'));
    act(() => exit!());
    await flush();
  };

  it('a resume start that exits after the ready gate fired with "No conversation found" is retried fresh with the note', async () => {
    await resumeDiesAfterGate({ projectId: 'p1' });
    expect(gui.start).toHaveBeenCalledTimes(2);
    expect(gui.start.mock.calls[1]![0]).toEqual({ projectId: 'p1', cols: 80, rows: 24, mode: 'plan', restart: true, resume: false });
    expect(screen.getByText(NOTE)).toBeTruthy();
    expect(lastStatus().hasSent).toBe(false);
  });

  it('the retried start does not loop, even when it prints the phrase too', async () => {
    await resumeDiesAfterGate({ projectId: 'p1' });
    act(() => chunk!('No conversation found to continue'));
    act(() => exit!());
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Restart')).toBeTruthy();
  });

  it('Restart after a failed resume on the New chat starts fresh, never resumes', async () => {
    await resumeDiesAfterGate({ projectId: null });
    act(() => exit!()); // the fresh retry dies as well
    await flush();
    fireEvent.click(screen.getByText('Restart'));
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(3);
    expect(gui.start.mock.calls[2]![0]).toEqual({ projectId: null, cols: 80, rows: 24, mode: 'plan', resume: false });
  });

  it('a Restart-initiated resume that fails is not retried, and the next Restart starts fresh', async () => {
    await startPane({ projectId: 'p1' });
    await send();
    await advance(3100);
    choose('Auto', 'Plan');
    fireEvent.click(screen.getByText('Switch'));
    await flush();
    act(() => exit!()); // the switch fails before ready
    fireEvent.click(screen.getByText('Restart'));
    await flush();
    expect(gui.start.mock.calls[2]![0]).toMatchObject({ resume: true });
    act(() => chunk!('Windows PowerShell'));
    await advance(1700);
    act(() => chunk!('No conversation found with session ID: x'));
    act(() => exit!());
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(3); // Restart owns its rule: no automatic retry
    fireEvent.click(screen.getByText('Restart'));
    await flush();
    expect(gui.start.mock.calls[3]![0]).toMatchObject({ resume: false });
  });

  it('a non-resume start that printed the phrase and exits is not retried', async () => {
    install();
    render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    act(() => chunk!('No conversation found to continue'));
    await advance(1700);
    act(() => exit!());
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(screen.getByText('Restart')).toBeTruthy();
  });

  it('a resumed pane that submitted a turn, or whose phrase scrolled out of the last 400 chars, is not retried', async () => {
    install();
    render(<Pane projectId="p1" resume onLiveChange={vi.fn()} />);
    await flush();
    act(() => chunk!('hello'));
    await advance(1700);
    await send();
    act(() => chunk!('No conversation found'));
    act(() => exit!());
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(1);
    cleanup();
    install();
    render(<Pane projectId="p1" resume onLiveChange={vi.fn()} />);
    await flush();
    act(() => chunk!('No conversation found'));
    act(() => chunk!('x'.repeat(500)));
    await advance(1700);
    act(() => exit!());
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(1);
  });

  it('a mode-switch resume that fails with "No conversation found" after the ready gate is not retried fresh', async () => {
    await startPane({ projectId: 'p1' });
    await send();
    await advance(3100);
    choose('Auto', 'Plan');
    fireEvent.click(screen.getByText('Switch'));
    await flush();
    act(() => chunk!('Windows PowerShell'));
    await advance(1700); // the gate fired: onReady cleared the pending switch
    act(() => chunk!('No conversation found with session ID: x'));
    act(() => exit!());
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(screen.getByText('Restart')).toBeTruthy();
  });

  it('stale "No conversation found" text from an earlier start does not retry a later clean resume, and Restart keeps resuming', async () => {
    await startPane({ projectId: 'p1' });
    await send();
    act(() => chunk!('No conversation found')); // printed by a non-resume start
    act(() => exit!());
    await flush();
    fireEvent.click(screen.getByText('Restart'));
    await flush();
    expect(gui.start.mock.calls[1]![0]).toMatchObject({ resume: true });
    act(() => chunk!('Windows PowerShell'));
    await advance(1700);
    act(() => exit!());
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(2); // tail was reset: no fresh retry
    fireEvent.click(screen.getByText('Restart'));
    await flush();
    expect(gui.start.mock.calls[2]![0]).toMatchObject({ resume: true });
  });

  it('a non-resume start that printed the phrase leaves the conversation resumable for Restart', async () => {
    install();
    render(<Pane projectId="p1" onLiveChange={vi.fn()} />);
    await flush();
    act(() => chunk!('No conversation found to continue'));
    await advance(1700);
    act(() => exit!());
    await flush();
    act(() => mocks.data!('hi\r')); // typed while stopped: a conversation exists again
    fireEvent.click(screen.getByText('Restart'));
    await flush();
    expect(gui.start.mock.calls[1]![0]).toMatchObject({ resume: true });
  });

  it('a mode-switch failure is not retried here', async () => {
    await startPane({ projectId: 'p1' });
    await send();
    await advance(3100);
    fireEvent.click(screen.getByLabelText('Permission mode: Auto'));
    fireEvent.click(screen.getByText('● Plan'));
    fireEvent.click(screen.getByText('Switch'));
    await flush();
    expect(gui.start.mock.calls[1]![0]).toMatchObject({ resume: true, mode: 'plan', restart: true });
    act(() => exit!());
    await flush();
    expect(gui.start).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(screen.getByText('Could not switch to Plan; staying on Auto')).toBeTruthy();
  });
});
