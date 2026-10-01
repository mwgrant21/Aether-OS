import { describe, it, expect } from 'vitest';
import { createLiveSeverityNarrator, createUnseenStatusReporter, RECOVERED_PREFIX, STALL_CHECK_INTERVAL_MS } from './liveSeverity';
import { STALL_MS } from './isStalled';
import { formatNarration } from '../narrationGenerator';
import { parseTranscriptLine, type TranscriptEvent } from '../transcriptParser';
import { applyLinesToOpenDispatches, type CompletedDispatchUsage, type RealAgentDispatch, type TrackedOutcome } from '../../src/state/liveAgentsMath';
import type { DispatchOutcome } from './parseDispatchOutcome';

function fakeBaseline(median: number | null = null) {
  const recorded: DispatchOutcome[] = [];
  return { recorded, medianFor: () => median, record: (_k: string, o: DispatchOutcome) => { recorded.push(o); return true; } };
}
const narrate = (t: string, s: 0 | 1 | 2 | 3 | 4) => formatNarration({ subagentType: t }, s)?.narration ?? null;
const T0 = Date.parse('2026-09-30T10:00:00.000Z');
function open(id: string, startedAt = new Date(T0).toISOString(), subagentType = 'code-reviewer'): RealAgentDispatch {
  return { toolUseId: id, subagentType, description: '', startedAt, prompt: '', model: null };
}
function completed(id: string, subagentType = 'code-reviewer'): CompletedDispatchUsage {
  return { ...open(id, new Date(T0).toISOString(), subagentType) };
}
const tracked = (status: DispatchOutcome['status'], durationMs?: number): TrackedOutcome => ({
  outcome: durationMs === undefined ? { status } : { status, usage: { tokens: 1, toolUses: 1, durationMs } },
  unknownStatusTag: null,
});
function line(obj: unknown): TranscriptEvent {
  return parseTranscriptLine(JSON.stringify(obj))!;
}
function dispatchEvent(id: string): TranscriptEvent {
  return line({ type: 'assistant', timestamp: '2026-09-30T10:00:00.000Z', message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'code-reviewer' } }] } });
}
function notificationEvent(id: string, status: string): TranscriptEvent {
  return line({ type: 'user', timestamp: '2026-09-30T10:03:00.000Z', origin: { kind: 'task-notification' }, message: { content: `<task-notification><tool-use-id>${id}</tool-use-id><status>${status}</status><summary>x</summary></task-notification>` } });
}

describe('live severity: integration from transcript lines', () => {
  it('a failed notification reaches narration as severity 4 (it arrived as 1 before this change)', () => {
    const events = [dispatchEvent('tu_f'), notificationEvent('tu_f', 'failed')];
    const done: CompletedDispatchUsage[] = [];
    const outcomes = new Map<string, TrackedOutcome>();
    applyLinesToOpenDispatches([], events, done, outcomes);
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    const payload = n.onCompleted(done[0], outcomes.get('tu_f'));
    expect(payload).toEqual({ toolUseId: 'tu_f', severity: 4, subagentType: 'code-reviewer', final: true, narration: formatNarration({ subagentType: 'code-reviewer' }, 4)!.narration });
  });
});

describe('createLiveSeverityNarrator', () => {
  it('check interval is ~30 s', () => {
    expect(STALL_CHECK_INTERVAL_MS).toBe(30_000);
  });

  it('killed -> 2, unknown/missing outcome -> 1, slow -> 2 with the snapshot taken before recording', () => {
    const b = fakeBaseline(1000);
    const n = createLiveSeverityNarrator({ baseline: b, narrate });
    expect(n.onCompleted(completed('a'), tracked('killed'))!.severity).toBe(2);
    expect(n.onCompleted(completed('b'), undefined)!.severity).toBe(1);
    expect(n.onCompleted(completed('c'), tracked('completed', 3001))!.severity).toBe(2);
    expect(b.recorded.map((o) => o.status)).toEqual(['killed', 'unknown', 'completed']);
  });

  it('a missing usage block is never slow: no elapsed means no slowness bump, whatever the median', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(1), narrate });
    expect(n.onCompleted(completed('m'), tracked('completed'))!.severity).toBe(1);
  });

  it('an unknown status with a slow usage block stays at 1: only completed runs get the slowness bump', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(1000), narrate });
    expect(n.onCompleted(completed('s'), tracked('unknown', 3001))!.severity).toBe(1);
  });

  it('a stall fires exactly once across ticks, as severity 4', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    const d = [open('s')];
    expect(n.checkStalls(d, T0 + STALL_MS, false)).toEqual([]);
    const first = n.checkStalls(d, T0 + STALL_MS + 1, false);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ toolUseId: 's', severity: 4, subagentType: 'code-reviewer', final: false });
    expect(n.checkStalls(d, T0 + STALL_MS + 30_000, false)).toEqual([]);
    expect(n.checkStalls(d, T0 + 5 * STALL_MS, true)).toEqual([]);
  });

  it('an ended session stalls every open dispatch once', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    const out = n.checkStalls([open('x'), open('y')], T0 + 1000, true);
    expect(out.map((p) => p.toolUseId).sort()).toEqual(['x', 'y']);
    expect(out.every((p) => p.severity === 4)).toBe(true);
    expect(n.checkStalls([open('x'), open('y')], T0 + 2000, true)).toEqual([]);
  });

  it('a late completed outcome replaces the stall and emits one "Recovered" line', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    n.checkStalls([open('r')], T0 + STALL_MS + 1, false);
    const p = n.onCompleted(completed('r'), tracked('completed', 5000))!;
    expect(p).toEqual({ toolUseId: 'r', severity: 1, subagentType: 'code-reviewer', final: true, narration: `${RECOVERED_PREFIX}${narrate('code-reviewer', 1)}` });
    const again = n.onCompleted(completed('r'), tracked('completed', 5000));
    expect(again === null || !again.narration.startsWith(RECOVERED_PREFIX)).toBe(true);
  });

  it('a recovered FORGE dispatch at severity 1 (no sample) still gets the single Recovered line', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    n.checkStalls([open('g', new Date(T0).toISOString(), 'general-purpose')], T0 + STALL_MS + 1, false);
    expect(n.onCompleted(completed('g', 'general-purpose'), tracked('completed', 5000))).toEqual({ toolUseId: 'g', narration: 'Recovered.', severity: 1, subagentType: 'general-purpose', final: true });
  });

  // Ruling 1: the prefix is for a real success only.
  it.each([
    ['failed', 4],
    ['killed', 2],
    ['unknown', 1],
  ] as const)('a stalled dispatch that later ends %s is narrated from that outcome, with no Recovered prefix', (status, severity) => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    n.checkStalls([open('p')], T0 + STALL_MS + 1, false);
    expect(n.onCompleted(completed('p'), tracked(status))).toEqual({ toolUseId: 'p', severity, subagentType: 'code-reviewer', final: true, narration: narrate('code-reviewer', severity) });
  });

  it('a stalled FORGE dispatch that later ends unknown clears the stall line: final payload with empty narration, no Recovered line', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    n.checkStalls([open('u', new Date(T0).toISOString(), 'general-purpose')], T0 + STALL_MS + 1, false);
    expect(n.onCompleted(completed('u', 'general-purpose'), tracked('unknown'))).toEqual({ toolUseId: 'u', narration: '', severity: 1, subagentType: 'general-purpose', final: true });
  });

  it('a silent unknown outcome with NO prior stall still returns null', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    expect(n.onCompleted(completed('v', 'general-purpose'), tracked('unknown'))).toBeNull();
  });

  // Review Focus 5
  it('completion before the stall check: narrated once from the real outcome, never as a stall', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    const p = n.onCompleted(completed('q'), tracked('failed'))!;
    expect(p.severity).toBe(4);
    expect(p.narration.startsWith(RECOVERED_PREFIX)).toBe(false);
    expect(n.checkStalls([], T0 + 10 * STALL_MS, true)).toEqual([]);
  });

  it('completion on the tick it would have been flagged: seen open earlier, completed now, no stall and no Recovered line', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    expect(n.checkStalls([open('w')], T0 + STALL_MS, false)).toEqual([]);
    const p = n.onCompleted(completed('w'), tracked('completed', 1000));
    expect(p).toEqual({ toolUseId: 'w', severity: 1, subagentType: 'code-reviewer', final: true, narration: narrate('code-reviewer', 1) });
    expect(n.checkStalls([], T0 + STALL_MS + 1, false)).toEqual([]);
  });

  // Review Focus 2
  it('epoch startedAt is measured from first sight, not from 1970', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    const d = [open('e', new Date(0).toISOString())];
    expect(n.checkStalls(d, T0, false)).toEqual([]);
    expect(n.checkStalls(d, T0 + STALL_MS, false)).toEqual([]);
    expect(n.checkStalls(d, T0 + STALL_MS + 1, false)).toHaveLength(1);
  });

  it('an unparsable startedAt is measured from first sight too', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    const d = [open('z', 'not a date')];
    expect(n.checkStalls(d, T0, false)).toEqual([]);
    expect(n.checkStalls(d, T0 + STALL_MS + 1, false)).toHaveLength(1);
  });

  it('payloads carry only toolUseId, narration, severity, final, subagentType', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    const p = n.onCompleted(completed('k'), tracked('failed'))!;
    // final: true = the dispatch really ended (Comms completion); false = stall line (roster only).
    expect(Object.keys(p).sort()).toEqual(['final', 'narration', 'severity', 'subagentType', 'toolUseId']);
  });
});

describe('createUnseenStatusReporter (one [diag] line per previously unseen status value)', () => {
  it('reports each unseen tag once, including __proto__ and constructor, without touching Object.prototype', () => {
    const protoKeysBefore = Object.getOwnPropertyNames(Object.prototype).sort();
    const lines: string[] = [];
    const report = createUnseenStatusReporter((l) => lines.push(l));
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const statuses = ['__proto__', '__proto__', 'constructor', 'constructor', 'completed'];
    const outcomes = new Map<string, TrackedOutcome>();
    applyLinesToOpenDispatches(
      [],
      [...ids.map(dispatchEvent), ...ids.map((id, i) => notificationEvent(id, statuses[i]))],
      [],
      outcomes,
    );
    for (const id of ids) report(outcomes.get(id)?.unknownStatusTag ?? null);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[diag\] dispatch status not recognised tag=__proto__; narrated as ok at=\S+$/);
    expect(lines[1]).toMatch(/^\[diag\] dispatch status not recognised tag=constructor; narrated as ok at=\S+$/);
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(protoKeysBefore);
    expect(Object.keys({})).toEqual([]);
    expect(typeof ({} as { constructor: unknown }).constructor).toBe('function');
  });

  it('ignores null (a recognised status)', () => {
    const lines: string[] = [];
    const report = createUnseenStatusReporter((l) => lines.push(l));
    report(null);
    expect(lines).toEqual([]);
  });
});

describe('live tool-error floor and subagent progress (spike GO)', () => {
  it('completed with 3 tool errors -> severity 3; 2 errors -> 1; killed with 5 -> 2; failed stays 4', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    expect(n.onCompleted(completed('t1'), tracked('completed', 1000), 3)!.severity).toBe(3);
    expect(n.onCompleted(completed('t0'), tracked('completed', 1000), 2)!.severity).toBe(1);
    expect(n.onCompleted(completed('t2'), tracked('killed'), 5)!.severity).toBe(2);
    expect(n.onCompleted(completed('t3'), tracked('failed'), 0)!.severity).toBe(4);
    expect(n.onCompleted(completed('t4'), tracked('completed', 1000), null)!.severity).toBe(1);
  });

  it('a recent subagent-file write is progress; a quiet file is not (31 min)', () => {
    const now = T0 + 2 * STALL_MS;
    const mk = () => createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    expect(mk().checkStalls([open('p')], now, false, () => now - 60_000)).toEqual([]);
    expect(mk().checkStalls([open('p')], now, false, () => now - 31 * 60_000)).toHaveLength(1);
    expect(mk().checkStalls([open('p')], now, false, () => null)).toHaveLength(1);
  });

  it('future mtime: within 5 min counts as progress, beyond 5 min is ignored', () => {
    const now = T0 + 2 * STALL_MS;
    const mk = () => createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    expect(mk().checkStalls([open('p')], now, false, () => now + 4 * 60_000)).toEqual([]);
    expect(mk().checkStalls([open('p')], now, false, () => now + 6 * 60_000)).toHaveLength(1);
  });
});
