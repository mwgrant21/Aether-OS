import { describe, it, expect } from 'vitest';
import { computeSeverity, exitStateForStatus } from './severity/computeSeverity.js';
import { parseDispatchOutcome } from './severity/parseDispatchOutcome.js';
import type { ExitState, Severity } from './personalitySpine.js';

// The rules themselves are tested in electron/severity/computeSeverity.test.ts.
// This proves the generated collector copy compiles and behaves the same under
// the collector's own build, and that personalitySpine still exports the types.
describe('collector severity copy', () => {
  it('failed -> error/4, killed -> killed/2, unknown -> ok/1', () => {
    const sev = (s: string) =>
      computeSeverity({ exit: exitStateForStatus(parseDispatchOutcome(`<status>${s}</status>`).status), elapsedMs: 0, medianMsAtEval: null });
    expect(sev('failed')).toMatchObject({ exitState: 'error', severity: 4 });
    expect(sev('killed')).toMatchObject({ exitState: 'killed', severity: 2 });
    expect(sev('running')).toMatchObject({ exitState: 'ok', severity: 1 });
  });

  it('personalitySpine re-exports ExitState including killed', () => {
    const e: ExitState = 'killed';
    const s: Severity = 2;
    expect([e, s]).toEqual(['killed', 2]);
  });
});
