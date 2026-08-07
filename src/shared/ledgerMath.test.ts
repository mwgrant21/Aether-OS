import { describe, it, expect } from 'vitest';
import type { TranscriptEvent } from '../../electron/transcriptParser';
import type { CompletedDispatchUsage } from '../state/liveAgentsMath';
import {
  sessionLedger,
  tiersInSession,
  estimateDispatchCost,
  blendedRateForTier,
  DISPATCH_OUTPUT_SHARE,
  reconcile,
  bucketByDay,
  cacheImpact,
} from './ledgerMath';

// Verified rates (see modelPricing.ts): sonnet 3/15, opus 5/25, haiku 1/5,
// fable 10/50. Cache writes are 1.25x the tier's input rate, cache reads 0.1x.

function ev(over: Partial<TranscriptEvent> & { usage?: TranscriptEvent['usage'] } = {}): TranscriptEvent {
  return {
    kind: 'assistant',
    sessionId: 'sess-1',
    timestamp: new Date('2026-08-07T12:00:00Z'),
    cwd: null,
    model: 'claude-sonnet-4-6',
    usage: null,
    toolUses: [],
    toolResults: [],
    isHumanPrompt: false,
    humanText: null,
    originKind: null,
    ...over,
  };
}

function usage(input = 0, output = 0, cacheCreation = 0, cacheRead = 0) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
  };
}

function dispatch(over: Partial<CompletedDispatchUsage> = {}): CompletedDispatchUsage {
  return {
    toolUseId: 'tu_1',
    subagentType: 'general-purpose',
    description: 'do a thing',
    startedAt: new Date(0).toISOString(),
    prompt: 'p',
    model: 'claude-sonnet-4-6',
    tokens: 0,
    toolUses: 0,
    durationMs: 0,
    ...over,
  };
}

const M = 1_000_000;

describe('sessionLedger', () => {
  it('returns a zeroed ExactCost for empty input', () => {
    expect(sessionLedger([])).toEqual({
      usd: 0,
      breakdown: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    });
  });

  it('breaks a single event out four ways', () => {
    const result = sessionLedger([ev({ usage: usage(M, M, M, M) })]);
    expect(result.breakdown.input).toBeCloseTo(3, 6); // 1M @ $3
    expect(result.breakdown.output).toBeCloseTo(15, 6); // 1M @ $15
    expect(result.breakdown.cacheCreation).toBeCloseTo(3.75, 6); // 1M @ $3 * 1.25
    expect(result.breakdown.cacheRead).toBeCloseTo(0.3, 6); // 1M @ $3 * 0.1
    expect(result.usd).toBeCloseTo(22.05, 6);
  });

  // The session card renders both the total and the breakdown; if they can
  // disagree, one of them is lying to the operator.
  it('always reports usd as exactly the sum of its breakdown', () => {
    const result = sessionLedger([
      ev({ usage: usage(1234, 5678, 910, 111213) }),
      ev({ model: 'claude-opus-4-8', usage: usage(99, 88, 77, 66) }),
      ev({ model: 'claude-haiku-4-5', usage: usage(5, 4, 3, 2) }),
    ]);
    const { input, output, cacheCreation, cacheRead } = result.breakdown;
    expect(result.usd).toBeCloseTo(input + output + cacheCreation + cacheRead, 12);
  });

  it('prices mixed model tiers in one session at their own rates', () => {
    const result = sessionLedger([
      ev({ model: 'claude-sonnet-4-6', usage: usage(M, 0, 0, 0) }), // $3
      ev({ model: 'claude-opus-4-8', usage: usage(0, M, 0, 0) }), // $25
      ev({ model: 'claude-haiku-4-5', usage: usage(M, 0, 0, 0) }), // $1
    ]);
    expect(result.breakdown.input).toBeCloseTo(4, 6); // 3 + 1
    expect(result.breakdown.output).toBeCloseTo(25, 6);
    expect(result.usd).toBeCloseTo(29, 6);
  });

  it('ignores non-assistant events and events without usage', () => {
    const result = sessionLedger([
      ev({ kind: 'user', usage: usage(M, M, 0, 0) }),
      ev({ kind: 'other', usage: usage(M, M, 0, 0) }),
      ev({ usage: null }),
    ]);
    expect(result.usd).toBe(0);
  });

  it('reports the distinct tiers involved', () => {
    expect(
      tiersInSession([
        ev({ model: 'claude-sonnet-4-6', usage: usage(1) }),
        ev({ model: 'claude-opus-4-8', usage: usage(1) }),
        ev({ model: 'claude-sonnet-5', usage: usage(1) }),
      ]),
    ).toEqual(['sonnet', 'opus']);
    expect(tiersInSession([])).toEqual([]);
  });
});

describe('estimateDispatchCost', () => {
  it('applies the blended tier rate to the scalar token count', () => {
    const result = estimateDispatchCost(dispatch({ tokens: M }));
    // sonnet blend: 0.8 * $15 + 0.2 * $3 = $12.60 per million
    expect(result.usdApprox).toBeCloseTo(12.6, 6);
    expect(result.basis).toBe('blended-tier-rate');
    expect(result.tokens).toBe(M);
  });

  it('blends per tier, not at one global rate', () => {
    expect(blendedRateForTier('sonnet')).toBeCloseTo(12.6, 6);
    expect(blendedRateForTier('opus')).toBeCloseTo(21, 6);
    expect(blendedRateForTier('haiku')).toBeCloseTo(4.2, 6);
    expect(blendedRateForTier('fable')).toBeCloseTo(42, 6);
  });

  it('pins the documented blend ratio', () => {
    // If this changes, every per-dispatch figure in the Ledger moves. It is
    // the estimate's entire error term, so it should not move silently.
    expect(DISPATCH_OUTPUT_SHARE).toBe(0.8);
  });

  it('returns a zero estimate for a zero-token dispatch, not NaN', () => {
    const result = estimateDispatchCost(dispatch({ tokens: 0 }));
    expect(result.usdApprox).toBe(0);
    expect(result.tokens).toBe(0);
  });

  it('treats a negative or non-finite token count as zero rather than crediting money back', () => {
    expect(estimateDispatchCost(dispatch({ tokens: -5 })).usdApprox).toBe(0);
    expect(estimateDispatchCost(dispatch({ tokens: NaN })).usdApprox).toBe(0);
  });

  it('falls back to the sonnet tier for a dispatch with no model recorded', () => {
    expect(estimateDispatchCost(dispatch({ model: null, tokens: M })).usdApprox).toBeCloseTo(12.6, 6);
  });
});

describe('reconcile', () => {
  it('reports a non-zero residual rather than forcing the numbers to agree', () => {
    const exact = sessionLedger([ev({ usage: usage(0, M, 0, 0) })]); // $15
    const estimates = [estimateDispatchCost(dispatch({ tokens: M / 2 }))]; // $6.30
    const r = reconcile(exact, estimates);
    expect(r.sessionUsd).toBeCloseTo(15, 6);
    expect(r.attributedUsdApprox).toBeCloseTo(6.3, 6);
    expect(r.residualUsd).toBeCloseTo(8.7, 6);
  });

  // A ledger that balances by hiding its error is lying. A negative residual
  // means the estimator is over-claiming, which is precisely the signal that
  // says the blend ratio needs revisiting -- clamping it destroys that.
  it('keeps a negative residual negative instead of clamping it to zero', () => {
    const exact = sessionLedger([ev({ usage: usage(0, M / 10, 0, 0) })]); // $1.50
    const estimates = [estimateDispatchCost(dispatch({ tokens: M }))]; // $12.60
    const r = reconcile(exact, estimates);
    expect(r.residualUsd).toBeLessThan(0);
    expect(r.residualUsd).toBeCloseTo(-11.1, 6);
  });

  it('attributes nothing when there are no dispatches, leaving the whole total unattributed', () => {
    const exact = sessionLedger([ev({ usage: usage(0, M, 0, 0) })]);
    const r = reconcile(exact, []);
    expect(r.attributedUsdApprox).toBe(0);
    expect(r.residualUsd).toBeCloseTo(r.sessionUsd, 12);
  });
});

describe('bucketByDay', () => {
  const NOW = Date.UTC(2026, 7, 7, 12, 0, 0); // 2026-08-07T12:00:00Z

  it('returns null for every bucket when there is no data at all', () => {
    expect(bucketByDay([], 'UTC', NOW)).toEqual({ today: null, week: null, month: null });
  });

  // The single most important rendering rule in the view: a period the
  // collector did not observe must never render as $0.00.
  it('distinguishes an observed-but-free period (0) from an unobserved one (null)', () => {
    const zeroCost = bucketByDay([ev({ timestamp: new Date(NOW), usage: usage(0, 0, 0, 0) })], 'UTC', NOW);
    expect(zeroCost.today).toBe(0);
    expect(zeroCost.today).not.toBeNull();

    const unobserved = bucketByDay([], 'UTC', NOW);
    expect(unobserved.today).toBeNull();
    expect(unobserved.today).not.toBe(0);
  });

  it('places events into today, the rolling week, and the calendar month', () => {
    const buckets = bucketByDay(
      [
        ev({ timestamp: new Date(Date.UTC(2026, 7, 7, 1, 0, 0)), usage: usage(M, 0, 0, 0) }), // today: $3
        ev({ timestamp: new Date(Date.UTC(2026, 7, 4, 1, 0, 0)), usage: usage(M, 0, 0, 0) }), // 3 days ago: $3
        ev({ timestamp: new Date(Date.UTC(2026, 6, 18, 1, 0, 0)), usage: usage(M, 0, 0, 0) }), // July: $3
      ],
      'UTC',
      NOW,
    );
    expect(buckets.today).toBeCloseTo(3, 6);
    expect(buckets.week).toBeCloseTo(6, 6); // today + 3 days ago
    expect(buckets.month).toBeCloseTo(6, 6); // August only -- the July event is excluded
  });

  it('includes the 7th day back and excludes the 8th', () => {
    const sevenBack = ev({ timestamp: new Date(NOW - 6 * 86_400_000), usage: usage(M, 0, 0, 0) });
    const eightBack = ev({ timestamp: new Date(NOW - 7 * 86_400_000), usage: usage(M, 0, 0, 0) });
    expect(bucketByDay([sevenBack], 'UTC', NOW).week).toBeCloseTo(3, 6);
    expect(bucketByDay([eightBack], 'UTC', NOW).week).toBeNull();
  });

  // The time zone is taken as a parameter precisely so this is testable and
  // does not silently vary with the machine's locale.
  it('honours the supplied time zone when deciding which day an event belongs to', () => {
    // 02:00 UTC on the 7th is still 20:00 on the 6th in Denver (UTC-6).
    const e = ev({ timestamp: new Date(Date.UTC(2026, 7, 7, 2, 0, 0)), usage: usage(M, 0, 0, 0) });
    expect(bucketByDay([e], 'UTC', NOW).today).toBeCloseTo(3, 6);
    const denver = bucketByDay([e], 'America/Denver', NOW);
    expect(denver.today).toBeNull(); // yesterday, locally
    expect(denver.week).toBeCloseTo(3, 6); // still inside the rolling window
  });

  it('skips events with no timestamp or an invalid one', () => {
    expect(
      bucketByDay(
        [ev({ timestamp: null, usage: usage(M) }), ev({ timestamp: new Date(NaN), usage: usage(M) })],
        'UTC',
        NOW,
      ),
    ).toEqual({ today: null, week: null, month: null });
  });
});

describe('cacheImpact', () => {
  it('reports zeroes for empty input', () => {
    expect(cacheImpact([])).toEqual({
      cacheReadTokens: 0,
      wouldHaveCostUsd: 0,
      actuallyCostUsd: 0,
      savedUsd: 0,
    });
  });

  it('computes the counterfactual saving for a single tier', () => {
    const result = cacheImpact([ev({ usage: usage(0, 0, 0, M) })]);
    expect(result.cacheReadTokens).toBe(M);
    expect(result.wouldHaveCostUsd).toBeCloseTo(3, 6); // 1M at the full $3 input rate
    expect(result.actuallyCostUsd).toBeCloseTo(0.3, 6); // at the 10% cache-read rate
    expect(result.savedUsd).toBeCloseTo(2.7, 6);
  });

  it('prices each tier at its own rate rather than averaging them', () => {
    const result = cacheImpact([
      ev({ model: 'claude-sonnet-4-6', usage: usage(0, 0, 0, M) }), // would $3, actual $0.30
      ev({ model: 'claude-opus-4-8', usage: usage(0, 0, 0, M) }), // would $5, actual $0.50
    ]);
    expect(result.cacheReadTokens).toBe(2 * M);
    expect(result.wouldHaveCostUsd).toBeCloseTo(8, 6);
    expect(result.actuallyCostUsd).toBeCloseTo(0.8, 6);
    expect(result.savedUsd).toBeCloseTo(7.2, 6);
  });

  // What cacheImpact charges for cache reads must equal what the session card
  // charges for them, or the two cards contradict each other on screen.
  it('agrees with the session ledger on what cache reads actually cost', () => {
    const events = [
      ev({ usage: usage(10, 20, 30, 40_000) }),
      ev({ model: 'claude-opus-4-8', usage: usage(1, 2, 3, 4_000) }),
    ];
    expect(cacheImpact(events).actuallyCostUsd).toBeCloseTo(sessionLedger(events).breakdown.cacheRead, 12);
  });

  it('ignores events with no cache reads', () => {
    expect(cacheImpact([ev({ usage: usage(M, M, M, 0) })]).cacheReadTokens).toBe(0);
  });
});
