import { describe, expect, it, vi } from 'vitest';
import { adoptOwned, type AdoptTarget } from './adopt';
import type { AttachResult } from './ownerClient';
import type { SlotInfo } from './protocol';
import type { TerminalSlotId } from '../../src/shared/remote/types';

const info = (slot: TerminalSlotId, state: 'running' | 'exited' = 'running'): SlotInfo =>
  ({ slot, state, cols: 100, rows: 30, meta: { m: slot }, startedAt: 5 });
const bare = (): AttachResult =>
  ({ pty: { resume: vi.fn(), resize: vi.fn() }, state: 'running', cols: 1, rows: 2, meta: {}, startedAt: 0, ring: [], seq: 0 }) as unknown as AttachResult;

function harness(slots: SlotInfo[], opts: { attachState?: Partial<Record<TerminalSlotId, 'running' | 'exited'>>; attach?: (s: TerminalSlotId) => Promise<AttachResult> } = {}) {
  const calls: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const ptys: Record<string, { resume: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn> }> = {};
  const client = {
    list: vi.fn(async () => slots),
    attach: vi.fn(opts.attach ?? (async (slot: TerminalSlotId) => {
      calls.push(`attach:${slot}`);
      const pty = { resume: vi.fn(() => calls.push(`resume:${slot}`)), resize: vi.fn((c: number, r: number) => calls.push(`resize:${slot}:${c}x${r}`)) };
      ptys[slot] = pty;
      return { pty, state: opts.attachState?.[slot] ?? 'running', cols: 100, rows: 30, meta: { m: slot }, startedAt: 5, ring: [{ seq: 1, d: 'x' }], seq: 1 } as unknown as AttachResult;
    })),
    forget: vi.fn((slot: TerminalSlotId) => { calls.push(`forget:${slot}`); }),
  };
  const mk = (slot: TerminalSlotId, startImpl?: () => void): AdoptTarget => ({
    start: vi.fn(() => { startImpl?.(); calls.push(`start:${slot}`); }),
    apply: vi.fn(() => { calls.push(`apply:${slot}`); }),
  });
  const log = vi.fn();
  const setTimer = (fn: () => void, ms: number) => { const t = { fn, ms }; timers.push(t); return () => { t.fn = () => {}; }; };
  return { calls, timers, ptys, client, mk, log, setTimer };
}

describe('adoptOwned', () => {
  it('orders start < resume < apply < first resize, resumes once, never replays the ring', async () => {
    const h = harness([info('claude')]);
    const target = h.mk('claude');
    const out = await adoptOwned({ client: h.client, targets: { claude: target }, setTimer: h.setTimer, log: h.log });
    expect(out).toEqual(['claude']);
    expect(h.calls).toEqual(['attach:claude', 'start:claude', 'resume:claude', 'apply:claude', 'resize:claude:100x29']);
    expect(h.ptys.claude.resume).toHaveBeenCalledTimes(1);
    expect(target.start).toHaveBeenCalledWith(h.ptys.claude, { cols: 100, rows: 30, meta: { m: 'claude' }, startedAt: 5 });
    expect(target.apply).toHaveBeenCalledWith({ cols: 100, rows: 30, meta: { m: 'claude' }, startedAt: 5 });
  });

  it('nudge sends rows-1 now and rows after nudgeDelayMs via the timer', async () => {
    const h = harness([info('codex')]);
    await adoptOwned({ client: h.client, targets: { codex: h.mk('codex') }, setTimer: h.setTimer, log: h.log, nudgeDelayMs: 77 });
    const nudge = h.timers.find(t => t.ms === 77)!;
    expect(h.ptys.codex.resize.mock.calls).toEqual([[100, 29]]);
    nudge.fn();
    expect(h.ptys.codex.resize.mock.calls).toEqual([[100, 29], [100, 30]]);
  });

  it('an exited slot is forgotten and not attached', async () => {
    const h = harness([info('claude', 'exited')]);
    const t = h.mk('claude');
    expect(await adoptOwned({ client: h.client, targets: { claude: t }, setTimer: h.setTimer, log: h.log })).toEqual([]);
    expect(h.client.forget).toHaveBeenCalledWith('claude');
    expect(h.client.attach).not.toHaveBeenCalled();
    expect(t.start).not.toHaveBeenCalled();
  });

  it('a slot that is exited at attach is forgotten and not started', async () => {
    const h = harness([info('claude')], { attachState: { claude: 'exited' } });
    const t = h.mk('claude');
    expect(await adoptOwned({ client: h.client, targets: { claude: t }, setTimer: h.setTimer, log: h.log })).toEqual([]);
    expect(h.client.forget).toHaveBeenCalledWith('claude');
    expect(t.start).not.toHaveBeenCalled();
    expect(h.ptys.claude.resume).not.toHaveBeenCalled();
  });

  it('a rejecting attach does not block the other slots and is not in the result', async () => {
    const h = harness([info('claude'), info('codex')], {
      attach: async (slot) => { if (slot === 'claude') throw new Error('timeout'); return bare(); },
    });
    const out = await adoptOwned({ client: h.client, targets: { claude: h.mk('claude'), codex: h.mk('codex') }, setTimer: h.setTimer, log: h.log });
    expect(out).toEqual(['codex']);
    expect(h.log).toHaveBeenCalledTimes(1);
  });

  it('a throwing target.start is isolated and its pty is never resumed', async () => {
    const h = harness([info('claude'), info('terminal2')]);
    const bad = h.mk('claude', () => { throw new Error('x'); });
    const out = await adoptOwned({ client: h.client, targets: { claude: bad, terminal2: h.mk('terminal2') }, setTimer: h.setTimer, log: h.log });
    expect(out).toEqual(['terminal2']);
    expect(h.ptys.claude.resume).not.toHaveBeenCalled();
    expect(h.ptys.terminal2.resume).toHaveBeenCalledTimes(1);
  });

  it('is bounded by budgetMs when an attach never resolves, and does not start late completions', async () => {
    let release!: (a: AttachResult) => void;
    const h = harness([info('claude')], { attach: () => new Promise<AttachResult>(r => { release = r; }) });
    const t = h.mk('claude');
    const p = adoptOwned({ client: h.client, targets: { claude: t }, setTimer: h.setTimer, log: h.log, budgetMs: 1234 });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    h.timers.find(x => x.ms === 1234)!.fn();
    expect(await p).toEqual([]);
    release(bare());
    await Promise.resolve(); await Promise.resolve();
    expect(t.start).not.toHaveBeenCalled();
  });

  it('a failing list resolves to [] without throwing', async () => {
    const h = harness([]);
    h.client.list.mockRejectedValueOnce(new Error('not connected'));
    expect(await adoptOwned({ client: h.client, targets: { claude: h.mk('claude') }, setTimer: h.setTimer, log: h.log })).toEqual([]);
  });

  it('a slot with no target is neither attached nor forgotten', async () => {
    const h = harness([info('terminal2'), info('codex', 'exited')]);
    const out = await adoptOwned({ client: h.client, targets: { claude: h.mk('claude') }, setTimer: h.setTimer, log: h.log });
    expect(out).toEqual([]);
    expect(h.client.attach).not.toHaveBeenCalled();
    expect(h.client.forget).not.toHaveBeenCalled();
  });
});
