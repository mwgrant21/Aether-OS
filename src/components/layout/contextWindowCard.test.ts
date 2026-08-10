import { describe, it, expect } from 'vitest';
import { deriveContextWindowCard } from './contextWindowCard';
import type { StatuslineSnapshot } from '../../shared/statuslinePayload';
import { STATUSLINE_STALE_AFTER_MS } from '../../shared/depletion';

const snapshot = (over: Partial<StatuslineSnapshot> = {}): StatuslineSnapshot => ({
  capturedAtMs: 0,
  sessionId: null,
  modelId: null,
  modelDisplayName: null,
  fiveHour: null,
  sevenDay: null,
  contextUsedPercentage: 42,
  contextWindowSize: 200_000,
  contextUsage: {
    inputTokens: 1_000,
    outputTokens: 500,
    cacheCreationInputTokens: 2_000,
    cacheReadInputTokens: 80_000,
  },
  totalCostUsd: null,
  currentDir: null,
  projectDir: null,
  ...over,
});

describe('deriveContextWindowCard', () => {
  it('reports unavailable when there is no statusline at all', () => {
    expect(deriveContextWindowCard(null).available).toBe(false);
  });

  it('reports unavailable rather than 0% right after /compact, when usage is null', () => {
    // contextUsage is null before the first API call and immediately after a
    // /compact. "No reading yet" and "0% full" are different facts.
    const card = deriveContextWindowCard(snapshot({ contextUsage: null, contextUsedPercentage: null }));
    expect(card.available).toBe(false);
    expect(card.pct).toBeNull();
  });

  it('uses the real window size from the payload, not a hardcoded 125000', () => {
    expect(deriveContextWindowCard(snapshot({ contextWindowSize: 200_000 })).windowSize).toBe(200_000);
  });

  it('counts input plus both cache fields, excluding output tokens', () => {
    // Matches contextUsedPercentage's own input-only definition. Output tokens
    // are not resident context, and including them would sum against a
    // different basis than the headline percentage.
    const card = deriveContextWindowCard(snapshot());
    expect(card.usedTokens).toBe(1_000 + 2_000 + 80_000);
  });

  it('clamps the ring geometry to 100 while still reporting the true percentage', () => {
    // A ring cannot render more than full. The displayed number stays truthful
    // so a future data defect is visible rather than hidden by the clamp.
    const card = deriveContextWindowCard(snapshot({ contextUsedPercentage: 663 }));
    expect(card.ringPct).toBe(100);
    expect(card.pct).toBe(663);
  });

  it('never derives an output figure from a fixed ratio of the total', () => {
    // The old card rendered Input as ctxUsed * 0.58 and Output as ctxUsed *
    // 0.42 -- invented numbers presented as measured. Every part must trace to
    // a real payload field.
    const card = deriveContextWindowCard(snapshot());
    expect(card.parts).toEqual([
      { label: 'Input', value: 1_000 },
      { label: 'Cache write', value: 2_000 },
      { label: 'Cache read', value: 80_000 },
    ]);
    expect(card.parts.reduce((n, p) => n + p.value, 0)).toBe(card.usedTokens);
  });

  it('floors the ring at 0 for a nonsensical negative percentage', () => {
    expect(deriveContextWindowCard(snapshot({ contextUsedPercentage: -5 })).ringPct).toBe(0);
  });

  it('marks a reading older than the staleness threshold as stale', () => {
    // This card now reads a feed that can stop being written -- the statusline
    // file on the dev machine was 14 days old when this was written. Rendering
    // a fortnight-old context fill as current is the same failure as issue #19:
    // a dead source presented as a live reading.
    const now = 10_000_000;
    const card = deriveContextWindowCard(
      snapshot({ capturedAtMs: now - (STATUSLINE_STALE_AFTER_MS + 1) }),
      now,
    );
    expect(card.available).toBe(true);
    expect(card.stale).toBe(true);
  });

  it('does not mark a reading inside the threshold as stale', () => {
    const now = 10_000_000;
    const card = deriveContextWindowCard(
      snapshot({ capturedAtMs: now - (STATUSLINE_STALE_AFTER_MS - 1) }),
      now,
    );
    expect(card.stale).toBe(false);
  });
});
