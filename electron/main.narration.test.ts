import { describe, it, expect } from 'vitest';
import { formatNarration } from './narrationGenerator';
import { createWaitClock, beginWait, endWait, activeDurationMs } from '../src/shared/waitClock';

// These tests exist to pin the exact call shapes main.ts's tick loop uses, so
// a future edit to either signature is caught here before it silently breaks
// the wiring.
describe('main.ts narration wiring shape', () => {
  it('formatNarration accepts a completed-dispatch-shaped object and a nullable median, returning {narration, severity} or null', () => {
    const result = formatNarration({ subagentType: 'code-reviewer', durationMs: 1200 }, null);
    const shapeOk = result === null || (typeof result.narration === 'string' && typeof result.severity === 'number');
    expect(shapeOk).toBe(true);
  });

  it('activeDurationMs takes the shape main.ts feeds it and removes an approval pause from the duration', () => {
    const clock = createWaitClock();
    const startedAtMs = new Date('2026-09-07T10:00:00.000Z').getTime();
    // A permission prompt answered 30s later, inside a 60s dispatch.
    beginWait(clock, 'req-1', startedAtMs + 10_000);
    endWait(clock, 'req-1', startedAtMs + 40_000);

    const measured = activeDurationMs(clock, startedAtMs, 60_000, startedAtMs + 60_000);

    expect(measured).toBe(30_000);
    // And the narration path accepts the corrected figure unchanged.
    const result = formatNarration({ subagentType: 'code-reviewer', durationMs: measured }, null);
    const shapeOk = result === null || (typeof result.narration === 'string' && typeof result.severity === 'number');
    expect(shapeOk).toBe(true);
  });
});
