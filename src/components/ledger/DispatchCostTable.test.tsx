import { describe, it, expect, afterEach } from 'vitest';
import { render as rtlRender, screen, within, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AetherStoreProvider } from '../../state/store';
import { DispatchCostTable, type DispatchCostRow } from './DispatchCostTable';
import { ESTIMATE_BASIS_TOOLTIP } from './format';

// useColors() reads the theme from the store, so every themed component needs
// the provider -- the established convention in this repo's component tests.
function render(ui: ReactNode) {
  return rtlRender(<AetherStoreProvider>{ui}</AetherStoreProvider>);
}

// This suite does not run with Vitest globals, so RTL never registers its
// automatic afterEach cleanup. Without this, a previous test's DOM survives
// and a queryByText(...).toBeNull() assertion is checked against the wrong
// render -- it fails here, but the same gap could just as easily make a
// negative assertion pass for the wrong reason.
afterEach(cleanup);

function row(over: Partial<DispatchCostRow> & { usdApprox?: number } = {}): DispatchCostRow {
  const { usdApprox = 1, ...rest } = over;
  return {
    toolUseId: 'tu_1',
    startedAt: new Date('2026-08-07T12:00:00Z').toISOString(),
    description: 'a dispatch',
    subagentType: 'general-purpose',
    durationMs: 1000,
    toolUses: 2,
    estimate: { usdApprox, basis: 'blended-tier-rate', tokens: 1000 },
    exitState: null,
    retries: null,
    ...rest,
  };
}

function costCells(): string[] {
  // Body rows only -- the header row has no numeric cells.
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell').at(-1)!.textContent!.trim());
}

describe('DispatchCostTable', () => {
  it('sorts by cost descending by default', () => {
    render(
      <DispatchCostTable
        rows={[
          row({ toolUseId: 'a', usdApprox: 1.0 }),
          row({ toolUseId: 'b', usdApprox: 9.5 }),
          row({ toolUseId: 'c', usdApprox: 4.25 }),
        ]}
      />,
    );
    // The "worst offender" question is what the view exists to answer, so the
    // answer must be the first row with no interaction.
    expect(costCells()).toEqual(['~$9.50', '~$4.25', '~$1.00']);
  });

  it('renders every cost figure with a tilde, never as a bare dollar amount', () => {
    render(<DispatchCostTable rows={[row({ usdApprox: 2.5 })]} />);
    expect(screen.getByText('~$2.50')).toBeTruthy();
    expect(screen.queryByText('$2.50')).toBeNull();
  });

  it('names the estimate basis in full rather than just saying "estimated"', () => {
    render(<DispatchCostTable rows={[row({ usdApprox: 2.5 })]} />);
    expect(screen.getByText('~$2.50').getAttribute('title')).toBe(ESTIMATE_BASIS_TOOLTIP);
    expect(ESTIMATE_BASIS_TOOLTIP).toContain('no input/output split');
  });

  // The cost-of-failure case: tokens spent, work failed or repeated.
  it('flags a fatal exit', () => {
    render(<DispatchCostTable rows={[row({ exitState: 'fatal' })]} />);
    expect(screen.getByText(/fatal/)).toBeTruthy();
  });

  it('flags retries, pluralising correctly', () => {
    render(<DispatchCostTable rows={[row({ toolUseId: 'a', retries: 1 })]} />);
    expect(screen.getByText(/1 retry/)).toBeTruthy();
  });

  it('does not flag a clean dispatch, nor one whose telemetry is unavailable', () => {
    render(
      <DispatchCostTable
        rows={[
          row({ toolUseId: 'ok', exitState: 'ok', retries: 0 }),
          row({ toolUseId: 'unknown', exitState: null, retries: null }),
        ]}
      />,
    );
    expect(screen.queryByText(/fatal/)).toBeNull();
    expect(screen.queryByText(/retr/)).toBeNull();
  });

  it('renders an explicit empty state rather than a blank card', () => {
    render(<DispatchCostTable rows={[]} />);
    expect(screen.getByText(/no completed dispatches/i)).toBeTruthy();
  });
});
