import { describe, expect, it, vi } from 'vitest';
import { ALERT_KINDS } from '../../src/shared/remote/types';
import type { PromptInfo, PromptReadPort, PromptTap, ThreadEvent, ThreadReadPort, ThreadTap } from '../../src/shared/remote/types';
import { ALERT_DEBOUNCE_MS, createAlertWatcher } from './alertWatcher';

const D = ALERT_DEBOUNCE_MS;

function rig(opts: { pending?: PromptInfo[]; withPrompts?: boolean } = {}) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const detachThread = vi.fn();
  const detachPrompt = vi.fn();
  const taps: { thread: ThreadTap | null; prompt: PromptTap | null } = { thread: null, prompt: null };
  const threadAttach = vi.fn();
  const threads: ThreadReadPort = {
    attach(_s, tap) { threadAttach(); taps.thread = tap; return { detach: detachThread }; },
  };
  const prompts: PromptReadPort = {
    attach(tap) { taps.prompt = tap; for (const p of opts.pending ?? []) tap.opened(p); return { detach: detachPrompt }; },
  };
  const onAlert = vi.fn();
  const watcher = createAlertWatcher({
    threads,
    prompts: opts.withPrompts === false ? undefined : prompts,
    onAlert,
    setTimeoutFn: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeoutFn: (h) => { timers.delete(h as number); },
  });
  const advance = (ms: number): void => {
    now += ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      timers.delete(due[0]);
      due[1].fn();
    }
  };
  const thread = (): ThreadTap => { if (!taps.thread) throw new Error('not attached'); return taps.thread; };
  const prompt = (): PromptTap => { if (!taps.prompt) throw new Error('not attached'); return taps.prompt; };
  const turn = (mark: 'busy' | 'idle', interrupted = false): void => { thread().turn?.({ mark, interrupted }); };
  return { watcher, onAlert, advance, thread, prompt, turn, timers, detachThread, detachPrompt, threadAttach };
}

let seq = 0;
const claude = (text: string, truncated = false): ThreadEvent => ({ k: 'claude', id: `c${seq++}`, at: 1, text, truncated });
const user = (text: string): ThreadEvent => ({ k: 'user', id: `u${seq++}`, at: 1, text, truncated: false });
const events = (r: ReturnType<typeof rig>, ...evs: ThreadEvent[]): void => r.thread().events({ q: 1, events: evs });
const snap = (r: ReturnType<typeof rig>, ...evs: ThreadEvent[]): void =>
  r.thread().snap({ q: 0, attached: true, working: false, workingSinceMs: null, events: evs });
const info = (id: string): PromptInfo => ({ id, tool: 'Bash', risk: 'LOW', summary: 's', ttlMs: 60000 });

describe('alertWatcher', () => {
  it('fires exactly once, only after the debounce following busy then idle', () => {
    const r = rig();
    r.watcher.start();
    r.turn('busy');
    r.turn('idle');
    r.advance(D - 1);
    expect(r.onAlert).not.toHaveBeenCalled();
    r.advance(1);
    expect(r.onAlert).toHaveBeenCalledTimes(1);
  });

  it('classifies the last claude text since the last user event', () => {
    const q = rig();
    q.watcher.start();
    events(q, user('go'), claude('Which file?'));
    q.turn('busy'); q.turn('idle'); q.advance(D);
    expect(q.onAlert).toHaveBeenLastCalledWith('question');

    const f = rig();
    f.watcher.start();
    events(f, claude('All done.'));
    f.turn('busy'); f.turn('idle'); f.advance(D);
    expect(f.onAlert).toHaveBeenLastCalledWith('finished');

    const n = rig();
    n.watcher.start();
    events(n, claude('All done.'), user('next'));
    n.turn('busy'); n.turn('idle'); n.advance(D);
    expect(n.onAlert).toHaveBeenLastCalledWith('input');
  });

  it('passes truncated to the classifier (truncated -> input)', () => {
    const r = rig();
    r.watcher.start();
    events(r, claude('All done.', true));
    r.turn('busy'); r.turn('idle'); r.advance(D);
    expect(r.onAlert).toHaveBeenCalledWith('input');
  });

  it('busy-idle-busy inside the window yields nothing; the next real idle fires one', () => {
    const r = rig();
    r.watcher.start();
    r.turn('busy'); r.turn('idle');
    r.advance(D - 1);
    r.turn('busy');
    r.advance(D * 2);
    expect(r.onAlert).not.toHaveBeenCalled();
    r.turn('idle'); r.advance(D);
    expect(r.onAlert).toHaveBeenCalledTimes(1);
  });

  it('a second idle with no busy between, and state frames, add no alert', () => {
    const r = rig();
    r.watcher.start();
    r.turn('busy'); r.turn('idle'); r.advance(D);
    r.thread().state({ q: 2, working: false, workingSinceMs: null });
    r.advance(120000);
    r.turn('idle'); r.advance(D);
    expect(r.onAlert).toHaveBeenCalledTimes(1);
  });

  it('an interrupted idle is silent, and so is a plain idle after it', () => {
    const r = rig();
    r.watcher.start();
    r.turn('busy'); r.turn('idle', true); r.advance(D * 2);
    r.turn('idle'); r.advance(D * 2);
    expect(r.onAlert).not.toHaveBeenCalled();
  });

  it('history in a snap never alerts, including after stop() then start()', () => {
    const r = rig();
    r.watcher.start();
    snap(r, user('a'), claude('Done.'));
    r.advance(D * 2);
    r.watcher.stop();
    r.watcher.start();
    snap(r, user('a'), claude('Done.'));
    r.advance(D * 2);
    expect(r.onAlert).not.toHaveBeenCalled();
    expect(r.threadAttach).toHaveBeenCalledTimes(2);
  });

  it('prompts: replayed pending is silent; later open fires input after the debounce; closed early is silent; same id once', () => {
    const r = rig({ pending: [info('old')] });
    r.watcher.start();
    r.advance(D * 2);
    expect(r.onAlert).not.toHaveBeenCalled();

    r.prompt().opened(info('p1'));
    r.advance(D - 1);
    expect(r.onAlert).not.toHaveBeenCalled();
    r.advance(1);
    expect(r.onAlert).toHaveBeenCalledTimes(1);
    expect(r.onAlert).toHaveBeenLastCalledWith('input');

    r.prompt().opened(info('p2'));
    r.prompt().closed({ id: 'p2', reason: 'answered-desktop' });
    r.advance(D * 2);
    expect(r.onAlert).toHaveBeenCalledTimes(1);

    r.prompt().opened(info('p1'));
    r.advance(D * 2);
    expect(r.onAlert).toHaveBeenCalledTimes(1);
    r.prompt().opened(info('old'));
    r.advance(D * 2);
    expect(r.onAlert).toHaveBeenCalledTimes(1);
  });

  it('output is only a literal alert kind, never the content', () => {
    const r = rig();
    r.watcher.start();
    const hostile = 'Open C:\\secret\\key.pem ? token=ghp_XXXXXXXXXXXX';
    events(r, user('x'), claude(hostile));
    r.turn('busy'); r.turn('idle'); r.advance(D);
    expect(r.onAlert).toHaveBeenCalledTimes(1);
    const call = r.onAlert.mock.calls.at(0);
    expect(call?.length).toBe(1);
    expect(ALERT_KINDS as readonly unknown[]).toContain(call?.at(0));
    const dump = JSON.stringify(r.onAlert.mock.calls);
    expect(dump).not.toContain('secret');
    expect(dump).not.toContain('ghp_');
  });

  it('stop() cancels timers, detaches both taps once, running() is false; start() twice attaches once', () => {
    const r = rig();
    r.watcher.start();
    r.watcher.start();
    expect(r.threadAttach).toHaveBeenCalledTimes(1);
    expect(r.watcher.running()).toBe(true);
    r.turn('busy'); r.turn('idle');
    r.prompt().opened(info('p9'));
    expect(r.timers.size).toBe(2);
    r.watcher.stop();
    expect(r.timers.size).toBe(0);
    r.advance(D * 2);
    expect(r.onAlert).not.toHaveBeenCalled();
    expect(r.detachThread).toHaveBeenCalledTimes(1);
    expect(r.detachPrompt).toHaveBeenCalledTimes(1);
    expect(r.watcher.running()).toBe(false);
  });
});
