import type { VerificationResultV1, VerdictKind } from '../../src/shared/crossEngineTypes';

const VALID_VERDICTS: VerdictKind[] = ['supported', 'contradicted', 'inconclusive'];

function inconclusive(summary: string): VerificationResultV1 {
  return { schemaVersion: 1, verdict: 'inconclusive', confidence: 0, summary, findings: [], tests: [], limitations: [summary] };
}

/** Never throws. Invalid or incomplete structured output becomes
 *  inconclusive rather than a successful verification via optimistic
 *  parsing -- see spec §8's explicit requirement. */
export function parseVerificationResult(raw: unknown): VerificationResultV1 {
  if (typeof raw !== 'object' || raw === null) return inconclusive('Codex returned a non-object result.');
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== 1) return inconclusive('Codex result had an unrecognized schema version.');
  if (typeof obj.verdict !== 'string' || !VALID_VERDICTS.includes(obj.verdict as VerdictKind)) {
    return inconclusive('Codex result had an invalid or missing verdict.');
  }
  const confidence = typeof obj.confidence === 'number' ? Math.min(1, Math.max(0, obj.confidence)) : 0;
  const summary = typeof obj.summary === 'string' ? obj.summary : '';
  const findings = Array.isArray(obj.findings)
    ? obj.findings
        .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
        .map((f) => ({
          severity: f.severity === 'warning' || f.severity === 'error' ? f.severity : ('info' as const),
          claim: typeof f.claim === 'string' ? f.claim : '',
          evidence: typeof f.evidence === 'string' ? f.evidence : '',
          file: typeof f.file === 'string' ? f.file : null,
          line: typeof f.line === 'number' ? f.line : null,
        }))
    : [];
  const tests = Array.isArray(obj.tests)
    ? obj.tests
        .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
        .map((t) => ({
          command: typeof t.command === 'string' ? t.command : '',
          outcome: t.outcome === 'passed' || t.outcome === 'failed' ? t.outcome : ('not-run' as const),
          detail: typeof t.detail === 'string' ? t.detail : '',
        }))
    : [];
  const limitations = Array.isArray(obj.limitations) ? obj.limitations.filter((l): l is string => typeof l === 'string') : [];

  const verdict = obj.verdict as VerdictKind;
  if (verdict !== 'inconclusive') {
    const hasWellFormedFinding = findings.some((f) => f.claim.trim() !== '' && f.evidence.trim() !== '');
    if (summary.trim() === '' || !hasWellFormedFinding) {
      return inconclusive('Codex returned a supported/contradicted verdict without supporting evidence.');
    }
  }

  return { schemaVersion: 1, verdict, confidence, summary, findings, tests, limitations };
}
