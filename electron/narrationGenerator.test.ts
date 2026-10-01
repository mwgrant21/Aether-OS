// electron/narrationGenerator.test.ts
import { describe, it, expect } from 'vitest';
import { formatNarration, narrationLine } from './narrationGenerator';

describe('formatNarration (render only; severity comes from electron/severity/computeSeverity)', () => {
  it('renders the role sample for the given severity', () => {
    expect(formatNarration({ subagentType: 'code-reviewer' }, 1)).toEqual({ narration: "It compiles. I'm thrilled.", severity: 1 });
    expect(formatNarration({ subagentType: 'code-reviewer' }, 2)).toEqual({ narration: "There's a retry loop in here. I'll assume that was deliberate.", severity: 2 });
  });
  it('returns null for FORGE at severity 1 (silent heartbeat)', () => {
    expect(formatNarration({ subagentType: 'general-purpose' }, 1)).toBeNull();
  });
  it('passes severity 4 through (the old local copy capped at 2)', () => {
    expect(formatNarration({ subagentType: 'code-reviewer' }, 4)?.severity).toBe(4);
  });
});

describe('narrationLine (the narrate dep main.ts hands to the live severity narrator)', () => {
  it('is the rendered text of formatNarration, or null when that is silent', () => {
    expect(narrationLine('code-reviewer', 1)).toBe("It compiles. I'm thrilled.");
    expect(narrationLine('code-reviewer', 4)).toBe(formatNarration({ subagentType: 'code-reviewer' }, 4)!.narration);
    expect(narrationLine('general-purpose', 1)).toBeNull();
  });
});
