import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { initialState } from '../../state/initialState';
import type { AetherState } from '../../state/types';
import type { LedgerSnapshot } from '../../shared/ledgerMath';
import type { QuotaEfficiency } from '../../shared/quotaEfficiency';
import type { StatuslineSnapshot } from '../../shared/statuslinePayload';

// Whole-branch review, FIX 6b. NO test rendered LedgerView with a populated
// store -- every existing test either exercised an exported helper
// (buildDispatchRows, selectTodaysRows) or rendered a single card with
// hand-built props. That gap is why FIX 2 (a $0.00 quota figure for a dispatch
// whose tokens were never reported) and FIX 3 (an "OBSERVED HERE: 0" before
// the first scan) both shipped green: each bug lived in the wiring BETWEEN a
// helper and a card, which is precisely what no test looked at.
//
// The store has no initial-state injection point (AetherStoreProvider builds
// its own via useReducer + loadPersisted), so useAetherStore is mocked with a
// whole AetherState built from the real initialState. useColors() reads the
// same hook, so the mocked state carries a real cfg and the themed components
// render exactly as they do in the app.
const store = vi.hoisted(() => ({ state: null as AetherState | null }));
vi.mock('../../state/store', () => ({
  useAetherStore: () => ({ state: store.state, dispatch: () => {} }),
}));

// eslint-disable-next-line import/first
import { LedgerView } from './LedgerView';

afterEach(() => {
  cleanup();
  store.state = null;
});

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);

const ledger: LedgerSnapshot = {
  // Deliberately non-round so no figure below collides with a "$0.00" the
  // absent-usage assertions are looking for.
  total: { usd: 137.42, breakdown: { input: 20.11, output: 90.2, cacheCreation: 22.11, cacheRead: 5 } },
  tiers: ['opus'],
  rollups: { today: 3.21, week: 44.5, month: 137.42 },
  cache: { cacheReadTokens: 5_000_000, wouldHaveCostUsd: 15, actuallyCostUsd: 1.5, savedUsd: 13.5 },
  cacheHitRate: 0.88,
  timeZone: 'UTC',
  computedAtMs: NOW,
};

const quota: QuotaEfficiency = {
  basis: 'seven_day',
  tokenBasis: 'input-output-cachewrite',
  bucketMs: 3_600_000,
  windowMs: 7 * 24 * 3_600_000,
  computedAtMs: NOW,
  tokensPerPoint: 200_000,
  fittedBuckets: 6,
  externalUsageBuckets: 0,
  fittedTokens: 1_200_000,
  fittedPoints: 6,
  observedTokens: 3_400_000,
  buckets: [],
};

const statusline: StatuslineSnapshot = {
  capturedAtMs: NOW,
  sessionId: null, modelId: null, modelDisplayName: null,
  fiveHour: null,
  sevenDay: { usedPercentage: 58, resetsAtMs: NOW + 86_400_000 },
  contextUsedPercentage: null, contextWindowSize: null, contextUsage: null,
  totalCostUsd: null, currentDir: null, projectDir: null,
};

function mountState(over: Partial<AetherState> = {}): void {
  store.state = {
    ...initialState,
    cfg: { ...initialState.cfg, planMonthlyUsd: 200 },
    ledger,
    quotaEfficiency: quota,
    statusline,
    recentCompletedDispatches: [
      {
        toolUseId: 'tu_reported',
        subagentType: 'general-purpose',
        description: 'dispatch that reported usage',
        startedAt: new Date(NOW).toISOString(),
        prompt: '',
        model: 'claude-opus-4-8',
      },
      {
        toolUseId: 'tu_silent',
        subagentType: 'general-purpose',
        description: 'dispatch that never reported usage',
        startedAt: new Date(NOW).toISOString(),
        prompt: '',
        model: 'claude-opus-4-8',
      },
    ],
    // tu_silent is deliberately absent: this is the real shape of a dispatch
    // whose completion notification carried no usage.
    dispatchUsage: { tu_reported: { tokens: 1_000_000, toolUses: 4, durationMs: 5000 } },
    ...over,
  } as AetherState;
}

/**
 * The QUOTA cell of the dispatch row whose description matches.
 *
 * Read by column index rather than by searching the row's text, because the
 * neighbouring API-rate cell renders "~$0.00" for the same absent usage --
 * a substring search for "$0.00" matches THAT and would pass no matter what
 * the quota cell said. Column order is the header order in DispatchCostTable:
 * Description, Type, Duration, Tools, Tokens, Quota, API rate.
 */
const QUOTA_COLUMN_INDEX = 5;
function quotaCellFor(description: string): string {
  const row = screen.getByText(description).closest('[role="row"]');
  if (!row) throw new Error(`no row found for "${description}"`);
  const cells = row.querySelectorAll('[role="cell"]');
  return cells[QUOTA_COLUMN_INDEX]?.textContent ?? '';
}

/** The value rendered next to a QuotaCostCard label. */
function cardValueFor(label: string): string {
  const row = screen.getByText(label).parentElement;
  if (!row) throw new Error(`no row found for "${label}"`);
  return (row.textContent ?? '').replace(label, '');
}

describe('LedgerView (rendered with a populated store)', () => {
  // FIX 2. The rate axis was already enforced (no fit -> em dash); the token
  // axis was not. With tokensPerPoint 200,000 and a $200 plan both present,
  // quotaCostForTokens(0, 200_000, 200) returns { points: 0, usdPlan: 0 } and
  // the cell printed "$0.00" for work whose token count was never reported.
  it('renders an em dash, not $0.00, for a dispatch that reported no usage', () => {
    mountState();
    render(<LedgerView />);

    expect(quotaCellFor('dispatch that never reported usage')).toBe('—');
  });

  // The discriminating half: the same render must still price the dispatch
  // that DID report usage, so an em-dash-everywhere regression fails here.
  // 1,000,000 tokens / 200,000 per point = 5.0 points; 5.0 * ($200 / 400) =
  // $2.50, computed by hand rather than through quotaCostForTokens.
  it('still prices a dispatch that did report usage, in the same render', () => {
    mountState();
    render(<LedgerView />);

    expect(quotaCellFor('dispatch that reported usage')).toBe('$2.50');
  });

  // FIX 3, through the view rather than the card in isolation: the ~50s
  // post-launch window where the statusline has arrived but the 60s efficiency
  // tick has not. "OBSERVED HERE" printed 0 -- a measurement claim.
  it('does not fabricate an observed-token count before the first efficiency snapshot', () => {
    mountState({ quotaEfficiency: null });
    render(<LedgerView />);

    // The window figure is unaffected: it comes straight from the statusline.
    expect(screen.getByText('58.0 pts')).toBeTruthy();
    expect(screen.getByText('$29.00')).toBeTruthy(); // 58 * ($200 / 400)
    // The observed-token row itself: an em dash, never a fabricated 0.
    expect(cardValueFor('OBSERVED HERE')).toBe('—');
    expect(cardValueFor('TOKENS / POINT')).toMatch(/no scan yet/i);
  });

  // FIX 4. The largest figure in the view is priced at API rates a
  // subscription account never pays, and before this it was the only unlabelled
  // dollar model on the page -- next to a smaller, explicitly-labelled
  // "PLAN VALUE".
  it('marks the API-rate figures as not paid, so the largest number is not read as the real one', () => {
    mountState();
    render(<LedgerView />);

    // Twice: the all-transcripts total and this month's rollup.
    expect(screen.getAllByText('$137.42').length).toBeGreaterThan(0);
    expect(screen.getByText(/not what a subscription account pays/i)).toBeTruthy();
    expect(screen.getByText(/ROLLUP — API RATE \(NOT PAID\)/)).toBeTruthy();
    // And one framing line naming both models before either is shown.
    expect(screen.getByText(/not comparable/i)).toBeTruthy();
  });
});
