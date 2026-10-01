import { describe, it, expect } from 'vitest';
import { formatNarration, narrationLine } from './narrationGenerator';
import { createLiveSeverityNarrator } from './severity/liveSeverity';
import { STALL_MS } from './severity/isStalled';

// Exercises the same composition main.ts uses (createLiveSeverityNarrator +
// narrationLine, fed a TrackedOutcome). It does not import main.ts, so a
// change to main.ts's wiring is not caught here. Durations are wall clock from the notification's own <duration_ms>; see
// docs/superpowers/specs/2026-09-16-user-wait-subtraction-removal.md before
// changing that.
const dispatch = { toolUseId: 'tu_1', subagentType: 'code-reviewer', description: '', startedAt: '2026-09-30T10:00:00.000Z', prompt: '', model: null };
function narrator(median: number | null = null) {
  return createLiveSeverityNarrator({ baseline: { medianFor: () => median, record: () => false }, narrate: narrationLine });
}

describe('live narration composition (the parts main.ts wires)', () => {
  it('a failed outcome is narrated at severity 4 with the role line for 4', () => {
    const p = narrator().onCompleted(dispatch, { outcome: { status: 'failed' }, unknownStatusTag: null });
    expect(p).toEqual({ toolUseId: 'tu_1', severity: 4, subagentType: 'code-reviewer', final: true, narration: formatNarration({ subagentType: 'code-reviewer' }, 4)!.narration });
  });

  it('a normal completion is narrated at severity 1 with the exact sev-1 line', () => {
    const p = narrator(60_000).onCompleted(dispatch, { outcome: { status: 'completed', usage: { tokens: 10, toolUses: 1, durationMs: 60_000 } }, unknownStatusTag: null });
    expect(p).toEqual({ toolUseId: 'tu_1', severity: 1, subagentType: 'code-reviewer', final: true, narration: "It compiles. I'm thrilled." });
  });

  it('wall clock over 3x the median is severity 2, never more', () => {
    const p = narrator(1000).onCompleted(dispatch, { outcome: { status: 'completed', usage: { tokens: 10, toolUses: 1, durationMs: 10_000 } }, unknownStatusTag: null });
    expect(p).toEqual({ toolUseId: 'tu_1', severity: 2, subagentType: 'code-reviewer', final: true, narration: "There's a retry loop in here. I'll assume that was deliberate." });
  });

  it('checkStalls(open, nowMs, sessionEnded): nothing open is nothing to say; one stalled dispatch is one severity-4 line', () => {
    const n = narrator();
    expect(n.checkStalls([], Date.parse(dispatch.startedAt) + 2 * STALL_MS, false)).toEqual([]);
    expect(n.checkStalls([dispatch], Date.parse(dispatch.startedAt) + STALL_MS + 1, false)).toEqual([
      { toolUseId: 'tu_1', severity: 4, subagentType: 'code-reviewer', final: false, narration: formatNarration({ subagentType: 'code-reviewer' }, 4)!.narration },
    ]);
  });
});
