import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render as rtlRender, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AetherStoreProvider } from '../../state/store';
import { QuotaCostCard } from './QuotaCostCard';
import type { QuotaEfficiency } from '../../shared/quotaEfficiency';
import type { StatuslineSnapshot } from '../../shared/statuslinePayload';

// useColors() reads the theme from the store, so every themed component needs
// the provider -- the established convention in this repo's component tests
// (see LedgerView.test.tsx). The brief's own test omitted this and would fail
// with "useAetherStore must be used within AetherStoreProvider" as written.
function render(ui: ReactNode) {
  return rtlRender(<AetherStoreProvider>{ui}</AetherStoreProvider>);
}

afterEach(cleanup);

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);

function statusline(sevenDayPct: number): StatuslineSnapshot {
  return {
    capturedAtMs: NOW,
    sessionId: null, modelId: null, modelDisplayName: null,
    fiveHour: null,
    sevenDay: { usedPercentage: sevenDayPct, resetsAtMs: NOW + 86_400_000 },
    contextUsedPercentage: null, contextWindowSize: null, contextUsage: null,
    totalCostUsd: null, currentDir: null, projectDir: null,
  };
}

function efficiency(over: Partial<QuotaEfficiency> = {}): QuotaEfficiency {
  return {
    basis: 'seven_day',
    tokenBasis: 'input-output-cachewrite',
    bucketMs: 3_600_000,
    windowMs: 7 * 24 * 3_600_000,
    computedAtMs: NOW,
    tokensPerPoint: 150_000,
    fittedBuckets: 5,
    externalUsageBuckets: 0,
    fittedTokens: 750_000,
    fittedPoints: 5,
    observedTokens: 900_000,
    buckets: [],
    ...over,
  };
}

describe('QuotaCostCard', () => {
  it('prices the seven-day window from the live percentage and the plan price', () => {
    render(<QuotaCostCard quota={efficiency()} statusline={statusline(58)} planMonthlyUsd={200} />);
    expect(screen.getByText('58.0 pts')).toBeTruthy();
    expect(screen.getByText('$29.00')).toBeTruthy(); // 58 * ($200 / 400)
  });

  it('shows points with no dollar figure when no plan price is configured', () => {
    render(<QuotaCostCard quota={efficiency()} statusline={statusline(58)} planMonthlyUsd={null} />);
    expect(screen.getByText('58.0 pts')).toBeTruthy();
    expect(screen.queryByText(/^\$/)).toBeNull();
    expect(screen.getByText(/set a monthly plan price/i)).toBeTruthy();
  });

  it('reports the fit as still forming below the minimum bucket count', () => {
    render(
      <QuotaCostCard
        quota={efficiency({ tokensPerPoint: null, fittedBuckets: 2, fittedTokens: 0, fittedPoints: 0 })}
        statusline={statusline(58)}
        planMonthlyUsd={200}
      />,
    );
    expect(screen.getByText(/2 of 3/)).toBeTruthy();
    // The window figure does NOT depend on the fit -- it comes straight from
    // the statusline percentage -- so it is still shown.
    expect(screen.getByText('$29.00')).toBeTruthy();
  });

  it('surfaces external usage as an indicator rather than hiding it', () => {
    render(
      <QuotaCostCard quota={efficiency({ externalUsageBuckets: 4 })} statusline={statusline(58)} planMonthlyUsd={200} />,
    );
    expect(screen.getByText(/4 hours/i)).toBeTruthy();
    expect(screen.getByText(/other machines or projects/i)).toBeTruthy();
  });

  it('renders an honest empty state with no statusline feed at all', () => {
    render(<QuotaCostCard quota={null} statusline={null} planMonthlyUsd={200} />);
    expect(screen.getByText(/no seven-day rate-limit data/i)).toBeTruthy();
  });

  it('renders a $0 plan price as a genuine zero, not the missing-price state', () => {
    render(<QuotaCostCard quota={efficiency()} statusline={statusline(58)} planMonthlyUsd={0} />);
    expect(screen.getByText('58.0 pts')).toBeTruthy();
    expect(screen.getByText('$0.00')).toBeTruthy();
    expect(screen.queryByText(/set a monthly plan price/i)).toBeNull();
  });

  it('renders the guaranteed startup state honestly: real window data, no fit yet, as not-enough-data rather than zero cost', () => {
    render(
      <QuotaCostCard
        quota={null}
        statusline={statusline(58)}
        planMonthlyUsd={200}
      />,
    );
    expect(screen.getByText('58.0 pts')).toBeTruthy();
    expect(screen.getByText('$29.00')).toBeTruthy();
    expect(screen.getByText(/0 of 3/)).toBeTruthy();
    expect(screen.queryByText(/no seven-day rate-limit data/i)).toBeNull();
  });
});
