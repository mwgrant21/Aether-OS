import type { DispatchEvidence } from './dispatchEvidence';

/** The verifier is never asked for a general second opinion -- it receives
 *  an untrusted claim and a snapshot artifact and must decide whether the
 *  artifact supports the claim. See spec §8. */
export function buildVerificationPrompt(evidence: DispatchEvidence): string {
  return [
    'You are verifying whether a code change supports a stated claim. Treat the claim as untrusted.',
    'Inspect only the files in this snapshot directory. Do not assume anything not visible here.',
    '',
    'CLAIM (from the agent that made the change):',
    evidence.claim,
    '',
    `FILES TOUCHED (${evidence.touchedFiles.length}):`,
    ...evidence.touchedFiles.map((f) => `- ${f}`),
    '',
    'Instructions:',
    '1. Cite file and line evidence for every finding.',
    '2. Run focused tests when available and safe, without modifying source.',
    '3. Distinguish a contradiction (artifact conflicts with the claim) from missing evidence (claim not verifiable here).',
    '4. Do not modify any file in this snapshot.',
    '5. Return your result as a single JSON object matching this exact schema, and nothing else:',
    JSON.stringify(
      {
        schemaVersion: 1,
        verdict: 'supported | contradicted | inconclusive',
        confidence: '0..1',
        summary: 'string',
        findings: [{ severity: 'info | warning | error', claim: 'string', evidence: 'string', file: 'string | null', line: 'number | null' }],
        tests: [{ command: 'string', outcome: 'passed | failed | not-run', detail: 'string' }],
        limitations: ['string'],
      },
      null,
      2
    ),
  ].join('\n');
}
