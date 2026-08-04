import { describe, it, expect } from 'vitest';
import { formatNarration } from './narrationGenerator';

// This test exists to pin the exact call shape main.ts's tick loop uses
// (Step 3) so a future edit to formatNarration's signature is caught here
// before it silently breaks the wiring.
describe('main.ts narration wiring shape', () => {
  it('formatNarration accepts a completed-dispatch-shaped object and a nullable median', () => {
    const result = formatNarration({ subagentType: 'code-reviewer', durationMs: 1200 }, null);
    expect(typeof result === 'string' || result === null).toBe(true);
  });
});
