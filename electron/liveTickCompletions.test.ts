import { describe, it, expect } from 'vitest';
import { createTickCompletionHandler } from './liveTickCompletions';
import { createLiveSeverityNarrator, RECOVERED_PREFIX, type LiveNarrationPayload } from './severity/liveSeverity';
import { STALL_MS } from './severity/isStalled';
import { narrationLine } from './narrationGenerator';
import { parseTranscriptLine, type TranscriptEvent } from './transcriptParser';
import { applyLinesToOpenDispatches, type CompletedDispatchUsage, type RealAgentDispatch, type TrackedOutcome } from '../src/state/liveAgentsMath';

// Synthetic fixtures in the real notification shape; no transcript content.
const T0 = Date.parse('2026-09-30T10:00:00.000Z');
function line(obj: unknown): TranscriptEvent {
  return parseTranscriptLine(JSON.stringify(obj))!;
}
const dispatchEvent = (id: string) =>
  line({ type: 'assistant', timestamp: '2026-09-30T10:00:00.000Z', message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'code-reviewer' } }] } });
const notification = (id: string, status: string, usage = '') =>
  line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: `<task-notification><tool-use-id>${id}</tool-use-id><status>${status}</status><summary>x</summary>${usage}</task-notification>` } });
const USAGE = '<usage><subagent_tokens>700</subagent_tokens><tool_uses>3</tool_uses><duration_ms>4000</duration_ms></usage>';

function harness() {
  const narrator = createLiveSeverityNarrator({ baseline: { medianFor: () => null, record: () => true }, narrate: narrationLine });
  const narrations: LiveNarrationPayload[] = [];
  const completedBatches: CompletedDispatchUsage[][] = [];
  const diag: (string | null)[] = [];
  const handle = createTickCompletionHandler({
    narrator,
    reportUnseenStatus: (t) => diag.push(t),
    sendNarration: (p) => narrations.push(p),
    sendCompleted: (c) => completedBatches.push(c),
  });
  return { narrator, handle, narrations, completedBatches, diag };
}

function tickFrom(events: TranscriptEvent[], open: RealAgentDispatch[] = applyLinesToOpenDispatches([], [dispatchEvent('tu_s')])) {
  const completed: CompletedDispatchUsage[] = [];
  const outcomes = new Map<string, TrackedOutcome>();
  applyLinesToOpenDispatches(open, events, completed, outcomes);
  return { completed, outcomes };
}

describe('createTickCompletionHandler (shared by both liveAgentTracker.tick() call sites in main.ts)', () => {
  it('a stalled dispatch completed through the second (onPostToolUse) tick gets its real outcome, one Recovered line, and its usage emitted', () => {
    const h = harness();
    const open = applyLinesToOpenDispatches([], [dispatchEvent('tu_s')]);
    // Main tick: flagged as stalled.
    const stall = h.narrator.checkStalls(open, T0 + STALL_MS + 1, false);
    expect(stall).toHaveLength(1);
    expect(stall[0]).toMatchObject({ severity: 4, final: false });
    // The second tick site consumes the completion.
    h.handle(tickFrom([notification('tu_s', 'completed', USAGE)], open));
    expect(h.narrations).toEqual([
      { toolUseId: 'tu_s', severity: 1, final: true, narration: `${RECOVERED_PREFIX}${narrationLine('code-reviewer', 1)}` },
    ]);
    expect(h.completedBatches).toHaveLength(1);
    expect(h.completedBatches[0]).toEqual([expect.objectContaining({ toolUseId: 'tu_s', tokens: 700, toolUses: 3, durationMs: 4000 })]);
    // The stall is gone: nothing re-flags it.
    expect(h.narrator.checkStalls([], T0 + 3 * STALL_MS, true)).toEqual([]);
  });

  it('a failed completion is narrated at 4 (final), and an unrecognised status tag is reported', () => {
    const h = harness();
    h.handle(tickFrom([notification('tu_s', 'failed')]));
    expect(h.narrations).toEqual([{ toolUseId: 'tu_s', severity: 4, final: true, narration: narrationLine('code-reviewer', 4) }]);
    expect(h.diag).toEqual([null]);
    const h2 = harness();
    h2.handle(tickFrom([notification('tu_s', 'running')]));
    expect(h2.diag).toEqual(['running']);
  });

  it('a tick with no completions sends nothing', () => {
    const h = harness();
    h.handle({ completed: [], outcomes: new Map() });
    expect(h.narrations).toEqual([]);
    expect(h.completedBatches).toEqual([]);
  });
});
