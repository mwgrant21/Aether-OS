// src/shared/narrationVerbosity.test.ts
import { describe, it, expect } from 'vitest';
import { applyNarrationVerbosity } from './narrationVerbosity';

describe('applyNarrationVerbosity', () => {
  it('passes narration through unchanged at full', () => {
    expect(applyNarrationVerbosity('hello', 'full', 1)).toBe('hello');
  });

  it('passes narration through at terse regardless of severity (terse only affects future longer variants)', () => {
    expect(applyNarrationVerbosity('hello', 'terse', 2)).toBe('hello');
  });

  it('suppresses narration at silent for low severity', () => {
    expect(applyNarrationVerbosity('hello', 'silent', 1)).toBeNull();
    expect(applyNarrationVerbosity('hello', 'silent', 2)).toBeNull();
  });

  it('the severity >= 3 floor always renders even at silent (spec §11 Phase 1)', () => {
    expect(applyNarrationVerbosity('hello', 'silent', 3)).toBe('hello');
    expect(applyNarrationVerbosity('hello', 'silent', 4)).toBe('hello');
  });

  it('empty narration is always null regardless of dial (FORGE sev-1 heartbeat has no line)', () => {
    expect(applyNarrationVerbosity('', 'full', 1)).toBeNull();
  });
});
