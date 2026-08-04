// electron/narrationGenerator.test.ts
import { describe, it, expect } from 'vitest';
import { formatNarration } from './narrationGenerator';

describe('formatNarration', () => {
  it('resolves role from subagentType and renders that role’s sev-1 sample when nothing is anomalous', () => {
    const result = formatNarration({ subagentType: 'code-reviewer', durationMs: 5000 }, null);
    // code-reviewer -> CINDER; no medianMsAtEval and no retries -> sev 1
    expect(result).toBe("It compiles. I'm thrilled.");
  });

  it('returns null for FORGE at severity 1 (silent heartbeat, no chat line)', () => {
    const result = formatNarration({ subagentType: 'general-purpose', durationMs: 5000 }, null);
    expect(result).toBeNull();
  });

  it('escalates severity when duration exceeds 3x the median, same as computeSeverity', () => {
    const result = formatNarration({ subagentType: 'code-reviewer', durationMs: 10_000 }, 1000);
    // elapsedMs(10000) > 3 * medianMsAtEval(1000) -> sev 2
    expect(result).toBe("There's a retry loop in here. I'll assume that was deliberate.");
  });
});
