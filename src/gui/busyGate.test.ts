import { describe, expect, it, vi } from 'vitest';
import {
  BG_TASK_NEEDLES, BUSY_NEEDLES, GUI_BG_MARKER_RELIABLE, GUI_BUSY_CANARY_MS, GUI_BUSY_IDLE_SAMPLE_MS, GUI_BUSY_QUIET_MS,
  GUI_BUSY_SETTLE_MS, classifyWorkScreen, createBusyGate, isBusy,
} from './busyGate';

// Screens as claude 2.1.323 draws them (probe P4).
const IDLE = '> \n──────\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents';
const SPINNER = '● Running 1 shell command…\n✻ Churning…\n──────\n> \n  ⏵⏵ auto mode on';
const DONE_ROW = '✻ Churned for 5s · done 21:40\n> \n  ⏵⏵ auto mode on';
const PERMISSION = 'Do you want to create a.txt?\n  1. Yes\nEsc to cancel · Tab to amend';
const PLAN = 'Ready to code?\nEnter to select · ↑/↓ to navigate · Esc to cancel';
const BG_SHELL_FOOTER = '> \n  ⏵⏵ auto mode on · 1 shell · ↓ to manage';
const BG_SHELL_DONE = '✻ Cooked for 9s · 1 shell still running\n> ';
const BG_AGENT = '> \n  ⏵⏵ auto mode on · /tasks to see subagents';

function setup(initial = IDLE) {
  let t = 0;
  let screen = initial;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const changes: string[] = [];
  const onSettled = vi.fn();
  const trust: boolean[] = [];
  const gate = createBusyGate({
    schedule: (fn, ms) => { const x = { at: t + ms, fn, cancelled: false }; timers.push(x); return () => { x.cancelled = true; }; },
    readScreen: () => screen,
    onChange: (s) => changes.push(s),
    onSettled,
    onTrust: (v) => trust.push(v),
    now: () => t,
  });
  const advance = (ms: number): void => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((x) => !x.cancelled && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at;
      due.cancelled = true;
      due.fn();
    }
    t = end;
  };
  const live = (): number => timers.filter((x) => !x.cancelled).length;
  return { gate, advance, live, changes, onSettled, trust, setScreen: (s: string) => { screen = s; } };
}

describe('classifyWorkScreen', () => {
  it('reads the 2.1.323 screens', () => {
    expect(classifyWorkScreen(IDLE)).toBe('idle');
    expect(classifyWorkScreen(DONE_ROW)).toBe('idle');
    expect(classifyWorkScreen(SPINNER)).toBe('working');
    expect(classifyWorkScreen(PERMISSION)).toBe('waiting');
    expect(classifyWorkScreen(PLAN)).toBe('waiting');
    expect(classifyWorkScreen('Do you want to proceed?\n 1. Yes')).toBe('waiting');
  });
  it('a footer with esc to cancel alone is waiting', () => {
    expect(classifyWorkScreen('menu\nEsc to cancel')).toBe('waiting');
  });
  it('background shell and agent markers read as working; bare agent footer noise does not', () => {
    expect(classifyWorkScreen(BG_SHELL_FOOTER)).toBe('working');
    expect(classifyWorkScreen(BG_SHELL_DONE)).toBe('working');
    expect(classifyWorkScreen(BG_AGENT)).toBe('working');
    expect(classifyWorkScreen('> \n  ⏵⏵ auto mode on · ← 1 agent')).toBe('idle');
    expect(classifyWorkScreen('> \n  ⏵⏵ auto mode on · ← for agents')).toBe('idle');
  });
  it('an empty BG_TASK_NEEDLES never matches', () => {
    expect(classifyWorkScreen(BG_SHELL_FOOTER, { ...BUSY_NEEDLES, bgTask: [] })).toBe('idle');
    expect(BG_TASK_NEEDLES.length).toBeGreaterThan(0);
    expect(GUI_BG_MARKER_RELIABLE).toBe(true);
  });
  it('ignores needles outside the last 10 non-empty rows', () => {
    const filler = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n\n');
    expect(classifyWorkScreen(`✻ Churning…\n${filler}`)).toBe('idle');
    expect(classifyWorkScreen(`✻ Churning…\n${filler.split('\n\n').slice(1).join('\n\n')}`)).toBe('working');
  });
  it('isBusy is true for working and waiting only', () => {
    expect([isBusy('idle'), isBusy('working'), isBusy('waiting')]).toEqual([false, true, true]);
  });
});

describe('createBusyGate', () => {
  it('starts idle and a chunk with an idle screen stays idle', () => {
    const s = setup();
    s.gate.feed();
    s.advance(GUI_BUSY_IDLE_SAMPLE_MS + 10);
    expect(s.gate.state()).toBe('idle');
    expect(s.changes).toEqual([]);
  });
  it('turnStarted goes working at once; a quiet window with an idle screen goes idle once', () => {
    const s = setup();
    s.gate.turnStarted();
    expect(s.gate.state()).toBe('working');
    s.advance(GUI_BUSY_QUIET_MS);
    expect(s.gate.state()).toBe('idle');
    expect(s.changes).toEqual(['working', 'idle']);
  });
  it('the spinner row keeps it working past the window', () => {
    const s = setup(SPINNER);
    s.gate.turnStarted();
    s.advance(GUI_BUSY_QUIET_MS + 50);
    expect(s.gate.state()).toBe('working');
  });
  it('a background-task marker keeps it working', () => {
    const s = setup(BG_SHELL_DONE);
    s.gate.turnStarted();
    s.advance(GUI_BUSY_QUIET_MS + 50);
    expect(s.gate.state()).toBe('working');
  });
  it('a dialog moves it to waiting', () => {
    const s = setup(PERMISSION);
    s.gate.turnStarted();
    s.advance(GUI_BUSY_QUIET_MS + 50);
    expect(s.gate.state()).toBe('waiting');
    expect(s.changes).toEqual(['working', 'waiting']);
  });
  it('a chunk inside the window re-arms it: quiet is counted from the LAST chunk', () => {
    const s = setup();
    s.gate.turnStarted();
    s.advance(2000);
    s.gate.feed();
    s.advance(2000);
    expect(s.gate.state()).toBe('working');
    s.advance(1000);
    expect(s.gate.state()).toBe('idle');
  });
  it('a second turnStarted while working does not stack timers', () => {
    const s = setup();
    s.gate.turnStarted();
    const before = s.live();
    s.gate.turnStarted();
    expect(s.live()).toBe(before);
    s.advance(GUI_BUSY_QUIET_MS);
    expect(s.changes).toEqual(['working', 'idle']);
  });

  describe('idle sampling (Claude-initiated turns)', () => {
    it('with no turnStarted, a chunk whose screen shows the spinner moves idle -> working within a second', () => {
      const s = setup(IDLE);
      s.setScreen(SPINNER);
      s.gate.feed();
      s.advance(GUI_BUSY_IDLE_SAMPLE_MS);
      expect(s.gate.state()).toBe('working');
    });
    it('a spinner emitting chunks faster than the sample window does not starve the sample', () => {
      const s = setup(SPINNER);
      for (let i = 0; i < 8; i++) { s.gate.feed(); s.advance(200); }
      expect(s.gate.state()).toBe('working');
    });
    it('a dialog seen while idle reads as waiting', () => {
      const s = setup(PLAN);
      s.gate.feed();
      s.advance(GUI_BUSY_IDLE_SAMPLE_MS);
      expect(s.gate.state()).toBe('waiting');
    });
  });

  describe('settled', () => {
    const toIdle = () => { const s = setup(); s.gate.turnStarted(); s.advance(GUI_BUSY_QUIET_MS); return s; };
    it('fires once after SETTLE_MS more quiet with a second idle read', () => {
      const s = toIdle();
      s.advance(GUI_BUSY_SETTLE_MS - 1);
      expect(s.onSettled).not.toHaveBeenCalled();
      s.advance(1);
      s.advance(10000);
      expect(s.onSettled).toHaveBeenCalledTimes(1);
    });
    it('a chunk pushes it out to 3 s after the chunk', () => {
      const s = toIdle();
      s.advance(2000);
      s.gate.feed();
      s.advance(2000);
      expect(s.onSettled).not.toHaveBeenCalled();
      s.advance(1000);
      expect(s.onSettled).toHaveBeenCalledTimes(1);
    });
    it('a working read at the settle moment cancels it and the gate is busy again', () => {
      const s = toIdle();
      s.setScreen(SPINNER);
      s.advance(GUI_BUSY_SETTLE_MS);
      expect(s.onSettled).not.toHaveBeenCalled();
      expect(s.gate.state()).toBe('working');
    });
    it('reset() in between cancels it', () => {
      const s = toIdle();
      s.gate.reset();
      s.advance(10000);
      expect(s.onSettled).not.toHaveBeenCalled();
    });
    it('turnStarted in between cancels it', () => {
      const s = toIdle();
      s.gate.turnStarted();
      s.setScreen(SPINNER);
      s.advance(10000);
      expect(s.onSettled).not.toHaveBeenCalled();
    });
  });

  describe('canary', () => {
    const streamIdle = (s: ReturnType<typeof setup>, ms: number) => { for (let t = 0; t < ms; t += 500) { s.gate.feed(); s.advance(500); } };
    it('output for more than CANARY_MS after turnStarted with every read idle flips trust off, a later working read back on', () => {
      const s = setup(IDLE);
      s.gate.turnStarted();
      streamIdle(s, GUI_BUSY_CANARY_MS + 1500);
      expect(s.trust).toEqual([false]);
      expect(s.gate.trusted()).toBe(false);
      s.setScreen(SPINNER);
      streamIdle(s, 1500);
      expect(s.trust).toEqual([false, true]);
    });
    it('a short reply that ends inside the window with no match never flips it', () => {
      const s = setup(IDLE);
      s.gate.turnStarted();
      streamIdle(s, 1500);
      s.advance(GUI_BUSY_QUIET_MS + 1000);
      s.advance(10000);
      expect(s.trust).toEqual([]);
    });
    it('a turn whose reads saw the working screen never flips it', () => {
      const s = setup(SPINNER);
      s.gate.turnStarted();
      streamIdle(s, 2000);
      s.setScreen(IDLE);
      streamIdle(s, GUI_BUSY_CANARY_MS + 1500);
      expect(s.trust).toEqual([]);
    });
  });

  it('reset() and dispose() cancel every timer and nothing fires afterwards', () => {
    for (const end of ['reset', 'dispose'] as const) {
      const s = setup(SPINNER);
      s.gate.turnStarted();
      s.gate.feed();
      s.gate[end]();
      expect(s.live()).toBe(0);
      s.advance(20000);
      expect(s.onSettled).not.toHaveBeenCalled();
    }
  });
  it('reset() returns to idle and reports it; after dispose, feed and turnStarted do nothing', () => {
    const s = setup(SPINNER);
    s.gate.turnStarted();
    s.gate.reset();
    expect(s.gate.state()).toBe('idle');
    expect(s.changes).toEqual(['working', 'idle']);
    s.gate.dispose();
    s.gate.turnStarted();
    s.gate.feed();
    expect(s.gate.state()).toBe('idle');
    expect(s.live()).toBe(0);
  });
});
