import { describe, it, expect } from 'vitest';
import { parseVerificationResult } from './verificationResult';

describe('parseVerificationResult', () => {
  it('parses a well-formed result unchanged', () => {
    const raw = { schemaVersion: 1, verdict: 'supported', confidence: 0.9, summary: 'ok', findings: [{ severity: 'info', claim: 'x', evidence: 'y', file: null, line: null }], tests: [], limitations: [] };
    expect(parseVerificationResult(raw)).toEqual(raw);
  });
  it('clamps confidence into 0..1', () => {
    const findings = [{ claim: 'x', evidence: 'y' }];
    expect(parseVerificationResult({ schemaVersion: 1, verdict: 'supported', confidence: 5, summary: 'ok', findings, tests: [], limitations: [] }).confidence).toBe(1);
    expect(parseVerificationResult({ schemaVersion: 1, verdict: 'supported', confidence: -5, summary: 'ok', findings, tests: [], limitations: [] }).confidence).toBe(0);
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
    const raw = { schemaVersion: 1, verdict: 'supported', confidence: 1, summary: 'ok', findings: ['not an object', { claim: 'x', evidence: 'y' }], tests: [], limitations: [] };
    const result = parseVerificationResult(raw);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].claim).toBe('x');
    expect(result.findings[0].severity).toBe('info');
  });

  it('falls back to inconclusive when a supported verdict has no findings', () => {
    const result = parseVerificationResult({ schemaVersion: 1, verdict: 'supported' });
    expect(result.verdict).toBe('inconclusive');
    expect(result.summary).toMatch(/without supporting evidence/);
  });

  it('falls back to inconclusive when a supported verdict has a summary but no well-formed findings', () => {
    const raw = { schemaVersion: 1, verdict: 'supported', summary: 'looks fine', findings: [{ claim: 'x', evidence: '' }] };
    expect(parseVerificationResult(raw).verdict).toBe('inconclusive');
  });

  it('falls back to inconclusive when a contradicted verdict has no summary', () => {
    const raw = { schemaVersion: 1, verdict: 'contradicted', findings: [{ claim: 'x', evidence: 'y' }] };
    expect(parseVerificationResult(raw).verdict).toBe('inconclusive');
  });

  it('preserves a supported verdict with a well-formed finding and non-empty summary', () => {
    const raw = { schemaVersion: 1, verdict: 'supported', confidence: 0.7, summary: 'matches the claim', findings: [{ claim: 'did X', evidence: 'saw X in the diff' }], tests: [], limitations: [] };
    const result = parseVerificationResult(raw);
    expect(result.verdict).toBe('supported');
    expect(result.findings).toHaveLength(1);
  });

  it('preserves an inconclusive verdict with no findings/summary (permissive as-is)', () => {
    const result = parseVerificationResult({ schemaVersion: 1, verdict: 'inconclusive' });
    expect(result.verdict).toBe('inconclusive');
  });
});
