import { describe, it, expect } from 'vitest';
import { parseVerificationResult } from './verificationResult';

describe('parseVerificationResult', () => {
  it('parses a well-formed result unchanged', () => {
    const raw = { schemaVersion: 1, verdict: 'supported', confidence: 0.9, summary: 'ok', findings: [], tests: [], limitations: [] };
    expect(parseVerificationResult(raw)).toEqual(raw);
  });
  it('clamps confidence into 0..1', () => {
    expect(parseVerificationResult({ schemaVersion: 1, verdict: 'supported', confidence: 5, summary: '', findings: [], tests: [], limitations: [] }).confidence).toBe(1);
    expect(parseVerificationResult({ schemaVersion: 1, verdict: 'supported', confidence: -5, summary: '', findings: [], tests: [], limitations: [] }).confidence).toBe(0);
  });
  it('returns inconclusive for null, non-object, or missing schemaVersion', () => {
    expect(parseVerificationResult(null).verdict).toBe('inconclusive');
    expect(parseVerificationResult('a string').verdict).toBe('inconclusive');
    expect(parseVerificationResult({}).verdict).toBe('inconclusive');
  });
  it('returns inconclusive for an invalid verdict value', () => {
    expect(parseVerificationResult({ schemaVersion: 1, verdict: 'maybe' }).verdict).toBe('inconclusive');
  });
  it('drops malformed findings entries rather than throwing', () => {
    const raw = { schemaVersion: 1, verdict: 'supported', confidence: 1, summary: '', findings: ['not an object', { claim: 'x' }], tests: [], limitations: [] };
    const result = parseVerificationResult(raw);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].claim).toBe('x');
    expect(result.findings[0].severity).toBe('info');
  });
});
