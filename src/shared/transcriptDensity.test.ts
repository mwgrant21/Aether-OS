import { describe, it, expect } from 'vitest';
import { applyDensity } from './transcriptDensity';

describe('applyDensity', () => {
  it('passes full content through unchanged at normal', () => {
    expect(applyDensity('the full prompt text', 'normal', 'a headline')).toBe('the full prompt text');
  });

  it('passes full content through unchanged at verbose', () => {
    expect(applyDensity('the full prompt text', 'verbose', 'a headline')).toBe('the full prompt text');
  });

  it('collapses to the headline alone at summary', () => {
    expect(applyDensity('the full prompt text', 'summary', 'a headline')).toBe('a headline');
  });

  it('falls back to the full content at summary when no headline is available', () => {
    expect(applyDensity('the full prompt text', 'summary', null)).toBe('the full prompt text');
  });
});
