import { describe, it, expect } from 'vitest';
import type { TranscriptEvent } from '../../electron/transcriptParser';
import {
  deriveQuotaEfficiency,
  tokenSamplesFromEvents,
  MIN_FIT_BUCKETS,
  DEFAULT_BUCKET_MS,
  type QuotaSample,
  type TokenSample,
} from './quotaEfficiency';

const H = DEFAULT_BUCKET_MS; // one hour
const T0 = Date.UTC(2026, 8, 1, 0, 0, 0); // an exact bucket boundary
const NOW = T0 + 24 * H;

/** A quota reading `n` buckets in, offset into the bucket so the "closing
 *  reading wins" rule is actually exercised rather than assumed. */
function q(bucket: number, usedPercentage: number, offsetMs = H - 1): QuotaSample {
  return { atMs: T0 + bucket * H + offsetMs, usedPercentage };
}
function t(bucket: number, tokens: number): TokenSample {
  return { atMs: T0 + bucket * H + 100, tokens };
}

describe('deriveQuotaEfficiency', () => {
  it('fits tokens per point from positive percentage deltas', () => {
    const result = deriveQuotaEfficiency(
      [q(0, 10), q(1, 12), q(2, 14), q(3, 18)],
      [t(1, 200_000), t(2, 200_000), t(3, 800_000)],
      { nowMs: NOW },
    );
    // Deltas: bucket1 +2, bucket2 +2, bucket3 +4 = 8 points for 1,200,000
    // tokens => 150,000 tokens per point.
    expect(result.fittedBuckets).toBe(3);
    expect(result.fittedPoints).toBeCloseTo(8, 10);
    expect(result.fittedTokens).toBe(1_200_000);
    expect(result.tokensPerPoint).toBeCloseTo(150_000, 6);
    expect(result.basis).toBe('seven_day');
  });

  it('treats a percentage DROP as a window reset and uses the current level as the delta', () => {
    const result = deriveQuotaEfficiency(
      [q(0, 90), q(1, 3), q(2, 5), q(3, 7)],
      [t(1, 300_000), t(2, 200_000), t(3, 200_000)],
      { nowMs: NOW },
    );
    // bucket1 dropped 90 -> 3: the window rolled over, so everything showing
    // (3 points) was consumed inside bucket1 -- never -87.
    const reset = result.buckets.find((b) => b.startMs === T0 + H);
    expect(reset?.points).toBeCloseTo(3, 10);
    expect(reset?.outcome).toBe('fitted');
    expect(result.fittedPoints).toBeCloseTo(3 + 2 + 2, 10);
  });

  it('excludes a bucket where the account moved but this machine logged nothing, and counts it', () => {
    const result = deriveQuotaEfficiency(
      [q(0, 10), q(1, 12), q(2, 20), q(3, 22), q(4, 24)],
      [t(1, 200_000), t(3, 200_000), t(4, 200_000)],
      { nowMs: NOW },
    );
    const external = result.buckets.find((b) => b.startMs === T0 + 2 * H);
    expect(external?.outcome).toBe('external-usage');
    expect(external?.points).toBeCloseTo(8, 10);
    expect(result.externalUsageBuckets).toBe(1);
    // The 8 external points are NOT in the fit: 3 buckets, 2 points each,
    // 600,000 tokens => 100,000 tokens per point.
    expect(result.fittedBuckets).toBe(3);
    expect(result.fittedPoints).toBeCloseTo(6, 10);
    expect(result.tokensPerPoint).toBeCloseTo(100_000, 6);
  });

  it('records a bucket with tokens but no percentage movement as no-quota-movement', () => {
    const result = deriveQuotaEfficiency(
      [q(0, 10), q(1, 10)],
      [t(1, 500_000)],
      { nowMs: NOW },
    );
    expect(result.buckets.find((b) => b.startMs === T0 + H)?.outcome).toBe('no-quota-movement');
    expect(result.fittedBuckets).toBe(0);
  });

  it('withholds tokensPerPoint until MIN_FIT_BUCKETS buckets carry both signals', () => {
    const two = deriveQuotaEfficiency(
      [q(0, 10), q(1, 12), q(2, 14)],
      [t(1, 200_000), t(2, 200_000)],
      { nowMs: NOW },
    );
    expect(MIN_FIT_BUCKETS).toBe(3);
    expect(two.fittedBuckets).toBe(2);
    expect(two.tokensPerPoint).toBeNull();
    // The points are still real and still reported -- only the rate is withheld.
    expect(two.fittedPoints).toBeCloseTo(4, 10);
  });

  it('uses each bucket CLOSING reading, so points consumed inside a bucket are not dropped', () => {
    const result = deriveQuotaEfficiency(
      [q(0, 10, 0), q(1, 11, 0), q(1, 20, H - 1), q(2, 22, H - 1), q(3, 24, H - 1)],
      [t(1, 1_000_000), t(2, 200_000), t(3, 200_000)],
      { nowMs: NOW },
    );
    // bucket1 closes at 20, not 11: its delta is 10, not 1.
    expect(result.buckets.find((b) => b.startMs === T0 + H)?.points).toBeCloseTo(10, 10);
  });

  it('ignores samples outside the window and never returns a rate from an empty series', () => {
    const stale = deriveQuotaEfficiency(
      [{ atMs: NOW - 30 * 24 * H, usedPercentage: 10 }, { atMs: NOW - 29 * 24 * H, usedPercentage: 40 }],
      [{ atMs: NOW - 29 * 24 * H, tokens: 500_000 }],
      { nowMs: NOW },
    );
    expect(stale.buckets).toEqual([]);
    expect(stale.tokensPerPoint).toBeNull();

    const empty = deriveQuotaEfficiency([], [], { nowMs: NOW });
    expect(empty.tokensPerPoint).toBeNull();
    expect(empty.fittedBuckets).toBe(0);
    expect(empty.observedTokens).toBe(0);
  });

  it('discards non-finite samples rather than poisoning the fit with NaN', () => {
    const result = deriveQuotaEfficiency(
      [q(0, 10), { atMs: Number.NaN, usedPercentage: 50 }, q(1, 12), q(2, 14), q(3, 16)],
      [t(1, 200_000), { atMs: T0 + 2 * H, tokens: Number.NaN }, t(2, 200_000), t(3, 200_000)],
      { nowMs: NOW },
    );
    expect(Number.isFinite(result.tokensPerPoint as number)).toBe(true);
    expect(result.fittedBuckets).toBe(3);
  });
});

describe('tokenSamplesFromEvents', () => {
  function ev(atMs: number, input: number, output: number, cacheCreation: number, cacheRead: number): TranscriptEvent {
    return {
      kind: 'assistant',
      sessionId: 's',
      timestamp: new Date(atMs),
      cwd: null,
      model: null,
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheCreationInputTokens: cacheCreation,
        cacheReadInputTokens: cacheRead,
      },
      toolUses: [],
      toolResults: [],
      isHumanPrompt: false,
      humanText: null,
      originKind: null,
    } as TranscriptEvent;
  }

  it('sums input, output and cache WRITES, excluding cache reads', () => {
    expect(tokenSamplesFromEvents([ev(T0, 100, 50, 25, 9_000)])).toEqual([{ atMs: T0, tokens: 175 }]);
  });

  it('skips events with no usage, no timestamp, or a non-assistant kind', () => {
    const noUsage = { ...ev(T0, 1, 1, 1, 1), usage: null } as TranscriptEvent;
    const noTime = { ...ev(T0, 1, 1, 1, 1), timestamp: null } as TranscriptEvent;
    const user = { ...ev(T0, 1, 1, 1, 1), kind: 'user' } as TranscriptEvent;
    expect(tokenSamplesFromEvents([noUsage, noTime, user])).toEqual([]);
  });
});
