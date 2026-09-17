import { describe, it, expect } from 'vitest';
import { formatNarration } from './narrationGenerator';

// These tests exist to pin the exact call shapes main.ts's tick loop uses, so
// a future edit to either signature is caught here before it silently breaks
// the wiring.
//
// There used to be a second test here pinning activeDurationMs, which fed
// formatNarration a duration with the operator's approval pauses subtracted
// out. That subtraction is gone -- main.ts now records wall clock -- so the
// shape being pinned is simply `c.durationMs`. See
// docs/superpowers/specs/2026-09-16-user-wait-subtraction-removal.md.
describe('main.ts narration wiring shape', () => {
  it('formatNarration accepts a completed-dispatch-shaped object and a nullable median, returning {narration, severity} or null', () => {
    const result = formatNarration({ subagentType: 'code-reviewer', durationMs: 1200 }, null);
    const shapeOk = result === null || (typeof result.narration === 'string' && typeof result.severity === 'number');
    expect(shapeOk).toBe(true);
  });

  it('accepts the raw wall-clock duration main.ts now feeds it', () => {
    const result = formatNarration({ subagentType: 'code-reviewer', durationMs: 60_000 }, null);
    const shapeOk = result === null || (typeof result.narration === 'string' && typeof result.severity === 'number');
    expect(shapeOk).toBe(true);
  });
});
