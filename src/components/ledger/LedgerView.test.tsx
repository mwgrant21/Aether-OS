import { describe, it, expect, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AetherStoreProvider } from '../../state/store';
import { RollupCard } from './RollupCard';
import { SessionCostCard } from './SessionCostCard';
import { CacheImpactCard } from './CacheImpactCard';
import { PricingBasisFooter } from './PricingBasisFooter';
import { buildDispatchRows } from './LedgerView';
import { PRICING_VERIFIED_AT } from '../../shared/modelPricing';

// useColors() reads the theme from the store, so every themed component needs
// the provider -- the established convention in this repo's component tests.
function render(ui: ReactNode) {
  return rtlRender(<AetherStoreProvider>{ui}</AetherStoreProvider>);
}

// This suite does not run with Vitest globals, so RTL never registers its
// automatic afterEach cleanup. Without this, a previous test's DOM survives
// and "queryByText(...).toBeNull()" assertions pass or fail against the wrong
// render entirely.
afterEach(cleanup);

describe('RollupCard', () => {
  // The single most important rendering rule in the view.
  it('renders a null bucket as an explicit no-data gap, never as $0.00', () => {
    render(<RollupCard rollups={{ today: null, week: null, month: null }} />);
    expect(screen.getAllByText(/collector not running/i)).toHaveLength(3);
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('renders an observed-but-free period as $0.00, distinct from no data', () => {
    render(<RollupCard rollups={{ today: 0, week: 1.5, month: 1.5 }} />);
    expect(screen.getByText('$0.00')).toBeTruthy();
    expect(screen.queryByText(/collector not running/i)).toBeNull();
  });

  it('marks a sub-cent total as smaller than a cent rather than rounding it to free', () => {
    render(<RollupCard rollups={{ today: 0.001, week: 0.001, month: 0.001 }} />);
    expect(screen.getAllByText('<$0.01').length).toBeGreaterThan(0);
    expect(screen.queryByText('$0.00')).toBeNull();
  });
});

describe('SessionCostCard', () => {
  const session = {
    usd: 22.05,
    breakdown: { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3 },
  };

  it('shows the exact total with no tilde, because it is exact', () => {
    render(<SessionCostCard session={session} tiers={['sonnet']} />);
    expect(screen.getByText('$22.05')).toBeTruthy();
    expect(screen.queryByText('~$22.05')).toBeNull();
  });

  it('shows a four-way breakdown that adds up to the displayed total', () => {
    render(<SessionCostCard session={session} tiers={['sonnet']} />);
    for (const part of ['$3.00', '$15.00', '$3.75', '$0.30']) {
      expect(screen.getByText(part)).toBeTruthy();
    }
    const { input, output, cacheCreation, cacheRead } = session.breakdown;
    expect(input + output + cacheCreation + cacheRead).toBeCloseTo(session.usd, 10);
  });

  it('names every tier involved when a session mixes them', () => {
    render(<SessionCostCard session={session} tiers={['sonnet', 'opus']} />);
    expect(screen.getByText(/tiers: sonnet, opus/)).toBeTruthy();
  });

  it('says so plainly when nothing priced was observed', () => {
    render(
      <SessionCostCard
        session={{ usd: 0, breakdown: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 } }}
        tiers={[]}
      />,
    );
    expect(screen.getByText(/no priced activity observed/i)).toBeTruthy();
  });
});

describe('CacheImpactCard', () => {
  it('reports the counterfactual saving', () => {
    render(
      <CacheImpactCard
        cache={{ cacheReadTokens: 1_000_000, wouldHaveCostUsd: 3, actuallyCostUsd: 0.3, savedUsd: 2.7 }}
        hitRatio={0.913}
      />,
    );
    expect(screen.getByText('$2.70 saved')).toBeTruthy();
    expect(screen.getByText('91.3%')).toBeTruthy();
  });

  it('does not claim a saving when no cache reads were observed', () => {
    render(
      <CacheImpactCard
        cache={{ cacheReadTokens: 0, wouldHaveCostUsd: 0, actuallyCostUsd: 0, savedUsd: 0 }}
        hitRatio={0}
      />,
    );
    expect(screen.getByText(/no cache reads observed/i)).toBeTruthy();
    expect(screen.queryByText(/saved/)).toBeNull();
  });
});

describe('PricingBasisFooter', () => {
  // This is what stops the table ageing into wrong without saying so.
  it('always shows the verification date and the rates actually in force', () => {
    render(<PricingBasisFooter />);
    expect(screen.getByText(PRICING_VERIFIED_AT)).toBeTruthy();
    expect(screen.getByText(/opus \$5\/\$25 per Mtok/)).toBeTruthy();
    expect(screen.getByText(/cache read 10% of input, cache write 1.25× input/)).toBeTruthy();
  });
});

describe('buildDispatchRows', () => {
  const base = {
    recentCompletedDispatches: [
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'scan', startedAt: '', prompt: '', model: 'claude-opus-4-8' },
    ],
    dispatchUsage: { tu_1: { tokens: 1_000_000, toolUses: 4, durationMs: 5000 } },
    diagnostics: { dispatches: [{ toolUseId: 'tu_1', exitState: 'fatal', retries: 2 }] },
  };

  it('joins the three renderer slices into a priced row', () => {
    const [r] = buildDispatchRows(base);
    expect(r.subagentType).toBe('general-purpose');
    expect(r.toolUses).toBe(4);
    // opus blend: 0.8 * $25 + 0.2 * $5 = $21 per million
    expect(r.estimate.usdApprox).toBeCloseTo(21, 6);
    expect(r.exitState).toBe('fatal');
    expect(r.retries).toBe(2);
  });

  // A row that is missing usage still tells the operator the dispatch
  // happened; dropping it would hide work rather than report it as unpriced.
  it('keeps a dispatch with no recorded usage, estimating it at zero', () => {
    const [r] = buildDispatchRows({ ...base, dispatchUsage: {} });
    expect(r.estimate.usdApprox).toBe(0);
    expect(r.estimate.tokens).toBe(0);
    expect(r.toolUses).toBe(0);
  });

  it('leaves telemetry null when the collector is absent or pre-v5', () => {
    const [r] = buildDispatchRows({ ...base, diagnostics: null });
    expect(r.exitState).toBeNull();
    expect(r.retries).toBeNull();
    // The cost estimate does not depend on telemetry, so it still lands.
    expect(r.estimate.usdApprox).toBeCloseTo(21, 6);
  });
});
