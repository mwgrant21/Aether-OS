import { describe, it, expect, afterEach } from 'vitest';
import { render as rtlRender, screen, within, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AetherStoreProvider } from '../../state/store';
import { DispatchCostTable, type DispatchCostRow } from './DispatchCostTable';
import { ESTIMATE_BASIS_TOOLTIP } from './format';
import { colors } from '../../styles/tokens';

// jsdom normalises inline colours to rgb(...), so compare against that form.
function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

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
    endedAt: new Date('2026-08-07T12:00:00Z').toISOString(),
    description: 'a dispatch',
    subagentType: 'general-purpose',
    durationMs: 1000,
    toolUses: 2,
    estimate: { usdApprox, basis: 'blended-tier-rate', tokens: 1000, tier: 'sonnet', tierSource: 'observed' },
    quota: { usdPlan: 1, points: 2, basis: 'seven_day', tokensPerPoint: 150_000 },
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
    expect(screen.getByText('~$2.50').closest('[role="cell"]')!.getAttribute('title')).toContain(ESTIMATE_BASIS_TOOLTIP);
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

  // Review finding: `troubled` matched only 'fatal', so a dispatch that burned
  // tokens and exited 'error'/'timeout'/'blocked' rendered as an ordinary row
  // -- precisely the case this table exists to surface.
  it.each(['error', 'timeout', 'blocked', 'fatal'] as const)('flags a %s exit', (exitState) => {
    render(<DispatchCostTable rows={[row({ exitState })]} />);
    expect(screen.getByText(exitState, { exact: true })).toBeTruthy();
  });

  it.each(['ok', 'partial'] as const)('does not flag a %s exit', (exitState) => {
    render(<DispatchCostTable rows={[row({ exitState, retries: 0 })]} />);
    expect(screen.queryByText(exitState, { exact: true })).toBeNull();
  });

  // Review finding: a defaulted tier is the COMMON case, and unmarked it is a
  // silent ~40% undercount on any dispatch that really ran on Opus.
  it('marks an estimate whose tier was assumed, and explains it on hover', () => {
    render(
      <DispatchCostTable
        rows={[row({ estimate: { usdApprox: 5, basis: 'blended-tier-rate', tokens: 10, tier: 'sonnet', tierSource: 'defaulted' } })]}
      />,
    );
    expect(screen.getByText('?')).toBeTruthy();
    const cell = screen.getByText('~$5.00').closest('[role="cell"]')!;
    expect(cell.getAttribute('title')).toContain('recorded no model');
  });

  it('does not mark an estimate whose tier was observed', () => {
    render(<DispatchCostTable rows={[row({ usdApprox: 5 })]} />);
    expect(screen.queryByText('?')).toBeNull();
  });

  it('renders an explicit empty state rather than a blank card', () => {
    render(<DispatchCostTable rows={[]} />);
    expect(screen.getByText(/no completed dispatches/i)).toBeTruthy();
  });

  it('mounts a VerifyWithCodexButton for a completed (ok) dispatch', () => {
    render(<DispatchCostTable rows={[row({ toolUseId: 'tu_verify', exitState: 'ok' })]} />);
    expect(screen.getByText('VERIFY WITH CODEX')).toBeTruthy();
  });

  it('does not mount a VerifyWithCodexButton for a non-completed dispatch', () => {
    render(<DispatchCostTable rows={[row({ toolUseId: 'tu_fatal', exitState: 'fatal' })]} />);
    expect(screen.queryByText('VERIFY WITH CODEX')).toBeNull();
  });

  it('shows a quota figure alongside the API estimate', () => {
    render(<DispatchCostTable rows={[row({
      estimate: { usdApprox: 1.5, basis: 'blended-tier-rate', tokens: 300_000, tier: 'sonnet', tierSource: 'observed' },
      quota: { usdPlan: 1, points: 2, basis: 'seven_day', tokensPerPoint: 150_000 },
    })]} />);
    expect(screen.getByText('$1.00')).toBeTruthy();   // quota, no tilde
    expect(screen.getByText('~$1.50')).toBeTruthy();  // API estimate, tilde retained
  });

  it('falls back to points when no plan price makes a dollar figure possible', () => {
    render(<DispatchCostTable rows={[row({
      quota: { usdPlan: null, points: 2, basis: 'seven_day', tokensPerPoint: 150_000 },
    })]} />);
    expect(screen.getByText('2.0 pts')).toBeTruthy();
  });

  it('shows an em dash, not a zero, when the fit has produced no rate yet', () => {
    render(<DispatchCostTable rows={[row({
      quota: { usdPlan: null, points: 0, basis: 'seven_day', tokensPerPoint: 0 },
    })]} />);
    // 0 points would read as "this dispatch consumed no quota", which is false
    // -- it consumed an unknown amount.
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('labels the API column as counterfactual, not as spend', () => {
    render(<DispatchCostTable rows={[row()]} />);
    expect(screen.getByText(/API RATE \(NOT PAID\)/i)).toBeTruthy();
  });

  // Review finding: a genuinely free plan price (usdPlan: 0, a real priced
  // state -- see QuotaCost's doc comment) combined with a real fit must
  // still render a dollar figure, not fall back to points. This is the exact
  // rendering-layer case the `>= 0` guard in quotaCostForTokens exists to
  // support, and it had no coverage at the layer the operator actually reads.
  it('renders a real $0.00, not points, for a genuinely free plan price with a real fit', () => {
    render(<DispatchCostTable rows={[row({
      quota: { usdPlan: 0, points: 3, basis: 'seven_day', tokensPerPoint: 150_000 },
    })]} />);
    expect(screen.getByText('$0.00')).toBeTruthy();
    expect(screen.queryByText('3.0 pts')).toBeNull();
  });

  it('labels a killed dispatch without failure styling', () => {
    render(
      <DispatchCostTable
        rows={[row({ toolUseId: 'k', exitState: 'killed' }), row({ toolUseId: 'c', exitState: 'ok' }), row({ toolUseId: 'f', exitState: 'fatal' })]}
      />,
    );
    const killedLabel = screen.getByText(/killed/);
    const fatalLabel = screen.getByText(/fatal/);
    const rows = screen.getAllByRole('row').slice(1);
    const killedRow = rows.find((r) => r.textContent!.includes('killed'))!;
    const cleanRow = rows.find((r) => !r.textContent!.includes('killed') && !r.textContent!.includes('fatal'))!;
    // Not the failure (danger) colour, and the row is not given trouble styling.
    expect(fatalLabel.style.color).not.toBe('');
    expect(killedLabel.style.color).not.toBe('');
    expect(killedLabel.style.color).not.toBe(fatalLabel.style.color);
    expect(killedRow.getAttribute('style')).toBe(cleanRow.getAttribute('style'));
  });

  it('pins the killed label to the muted text colour, not danger or warn', () => {
    render(<DispatchCostTable rows={[row({ toolUseId: 'k', exitState: 'killed' })]} />);
    expect(screen.getByText(/killed/).style.color).toBe(hexToRgb(colors.textDim));
  });

  it('a killed row with retries gets trouble row styling from the retries but keeps the muted label', () => {
    render(
      <DispatchCostTable rows={[row({ toolUseId: 'k', exitState: 'killed', retries: 2 }), row({ toolUseId: 'c', exitState: 'ok' })]} />,
    );
    const rows = screen.getAllByRole('row').slice(1);
    const killedRow = rows.find((r) => r.textContent!.includes('killed'))!;
    const cleanRow = rows.find((r) => !r.textContent!.includes('killed'))!;
    expect(killedRow.getAttribute('style')).not.toBe(cleanRow.getAttribute('style'));
    expect(screen.getByText(/killed/).style.color).toBe(hexToRgb(colors.textDim));
  });

  it('renders dashes, never fabricated zeros, for a row with no usage', () => {
    const { container } = render(
      <DispatchCostTable rows={[row({ toolUseId: 'k', exitState: 'killed', durationMs: null, toolUses: null, estimate: null, quota: null })]} />,
    );
    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell').map((c) => c.textContent!.trim());
    expect(cells.slice(2, 7)).toEqual(['\u2014', '\u2014', '\u2014', '\u2014', '\u2014']);
    expect(container.textContent).not.toContain('$0.00');
    expect(container.textContent).not.toContain('0ms');
    expect(container.textContent).not.toContain('~$0.00');
  });

  it('sorts rows with no estimate last in both directions', () => {
    render(
      <DispatchCostTable
        rows={[
          row({ toolUseId: 'n', description: 'none', estimate: null, quota: null }),
          row({ toolUseId: 'a', description: 'cheap', usdApprox: 1 }),
          row({ toolUseId: 'b', description: 'dear', usdApprox: 5 }),
        ]}
      />,
    );
    const order = () => screen.getAllByRole('row').slice(1).map((r) => r.textContent!.match(/none|cheap|dear/)![0]);
    expect(order()).toEqual(['dear', 'cheap', 'none']);
    fireEvent.click(screen.getByRole('button', { name: /toggle cost sort/i }));
    expect(order()).toEqual(['cheap', 'dear', 'none']);
  });
});
