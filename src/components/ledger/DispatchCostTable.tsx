import { useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import type { EstimatedCost, QuotaCost } from '../../shared/ledgerMath';
import type { ExitState } from '../../../collector/src/personalitySpine';
import {
  approxUsd,
  planUsd,
  points as fmtPoints,
  tokens as fmtTokens,
  duration as fmtDuration,
  ESTIMATE_BASIS_TOOLTIP,
  QUOTA_BASIS_TOOLTIP,
} from './format';
import { VerifyWithCodexButton } from '../agents/VerifyWithCodexButton';

export interface DispatchCostRow {
  toolUseId: string;
  /** ISO timestamp the dispatch opened; used to scope rows to a day. */
  startedAt: string;
  /**
   * ISO timestamp the dispatch is estimated to have finished (startedAt +
   * durationMs, or startedAt itself when duration is unavailable). Used
   * alongside startedAt so a dispatch spanning local midnight is scoped to
   * "today" if either end of it falls today.
   */
  endedAt: string;
  description: string;
  subagentType: string;
  durationMs: number;
  toolUses: number;
  estimate: EstimatedCost;
  /**
   * What this dispatch took out of the subscription quota, or `null` when the
   * dispatch's completion notification carried NO usage at all.
   *
   * Rendered ALONGSIDE `estimate`, never instead of it -- they answer
   * different questions ("what share of the plan did this take" vs "what would
   * this have cost on the API"), and the second is a counterfactual this
   * account never pays. The column header says so.
   *
   * Nullable for the same reason RollupBuckets is (ledgerMath.ts): an absent
   * measurement is not a zero one. A dispatch with no reported usage was
   * priced through quotaCostForTokens(0, rate, price), which returns a
   * perfectly well-formed `{ points: 0, usdPlan: 0 }` -- so the cell printed
   * "$0.00" for work whose token count was never reported. Zero here is
   * reserved for a dispatch that really did report zero tokens.
   */
  quota: QuotaCost | null;
  /** From the collector's schema-v5 columns. null means "not available". */
  exitState: ExitState | null;
  retries: number | null;
}

/**
 * The quota cell.
 *
 * Four states, all distinct on purpose:
 *   dollars  -- a plan price is set and the fit has a rate.
 *   points   -- the fit has a rate but no price is configured.
 *   em dash  -- no rate yet. NOT "0.0 pts": zero would read as "this dispatch
 *               consumed no quota", when the truth is that the amount is not
 *               yet knowable. This is the same null-versus-zero distinction
 *               RollupBuckets makes in ledgerMath.ts.
 *   em dash  -- no TOKENS reported for the dispatch (quota === null). The same
 *               rule on the other axis: the rate can be perfectly well known
 *               and the figure still unknowable, because the thing it would be
 *               multiplied by was never measured. Rendering $0.00 there was
 *               the rate-axis rule being enforced while the token axis was not.
 */
function quotaCell(quota: QuotaCost | null): string {
  if (quota === null) return '—';
  if (quota.tokensPerPoint <= 0) return '—';
  if (quota.usdPlan !== null) return planUsd(quota.usdPlan);
  return fmtPoints(quota.points);
}

/**
 * One row per completed dispatch, sorted by cost DESCENDING by default --
 * "which dispatch was the worst offender" is the question this view exists to
 * answer, so the answer is the first row without the operator doing anything.
 *
 * Every dollar figure here is an estimate and every one carries a `~` plus the
 * basis tooltip. There is no exact per-dispatch number available to render.
 */
export function DispatchCostTable({ rows }: { rows: DispatchCostRow[] }) {
  const colors = useColors();
  const [descending, setDescending] = useState(true);

  const sorted = [...rows].sort((a, b) =>
    descending ? b.estimate.usdApprox - a.estimate.usdApprox : a.estimate.usdApprox - b.estimate.usdApprox,
  );

  if (rows.length === 0) {
    return (
      <div style={cardStyle(colors)}>
        <div style={cardTitleStyle(colors)}>DISPATCHES</div>
        <div style={emptyStyle(colors)}>No completed dispatches observed in this scan.</div>
      </div>
    );
  }

  return (
    <div style={cardStyle(colors)}>
      <div style={headerRowStyle}>
        <div style={cardTitleStyle(colors)}>DISPATCHES</div>
        <Button
          onClick={() => setDescending((v) => !v)}
          style={sortBtnStyle(colors)}
          aria-label="Toggle cost sort direction"
        >
          cost {descending ? '▼' : '▲'}
        </Button>
      </div>

      <div role="table" style={tableStyle}>
        <div role="row" style={headRowStyle(colors)}>
          <span role="columnheader" style={colDesc}>Description</span>
          <span role="columnheader" style={colType}>Type</span>
          <span role="columnheader" style={colNum}>Duration</span>
          <span role="columnheader" style={colNum}>Tools</span>
          <span role="columnheader" style={colNum}>Tokens</span>
          <span role="columnheader" style={colNum} title={QUOTA_BASIS_TOOLTIP}>Quota</span>
          <span role="columnheader" style={colNum} title={ESTIMATE_BASIS_TOOLTIP}>API rate (not paid)</span>
        </div>

        {sorted.map((row) => {
          // The cost-of-failure signal: a dispatch that burned tokens and then
          // failed, or had to be retried, is exactly what this table is for.
          // Every FAILURE state, not just 'fatal'. ExitState also has
          // 'error' (recoverable), 'timeout' and 'blocked' -- a dispatch that
          // burned 80k tokens and exited 'error' is exactly the cost-of-failure
          // case this table exists to surface, and it was rendering clean.
          const failed = row.exitState !== null && row.exitState !== 'ok' && row.exitState !== 'partial';
          const troubled = failed || (row.retries !== null && row.retries > 0);
          return (
            <div role="row" key={row.toolUseId} style={bodyRowStyle(colors, troubled)}>
              <span role="cell" style={{ ...colDesc, ...descCellStyle(colors) }} title={row.description}>
                {row.description}
                {troubled && (
                  <span style={flagStyle(colors)}>
                    {failed ? row.exitState : null}
                    {failed && row.retries ? ' · ' : null}
                    {row.retries ? `${row.retries} ${row.retries === 1 ? 'retry' : 'retries'}` : null}
                  </span>
                )}
              </span>
              <span role="cell" style={{ ...colType, ...cellStyle(colors) }}>{row.subagentType}</span>
              <span role="cell" style={{ ...colNum, ...cellStyle(colors) }}>{fmtDuration(row.durationMs)}</span>
              <span role="cell" style={{ ...colNum, ...cellStyle(colors) }}>{row.toolUses}</span>
              <span role="cell" style={{ ...colNum, ...cellStyle(colors) }}>{fmtTokens(row.estimate.tokens)}</span>
              <span role="cell" style={{ ...colNum, ...cellStyle(colors) }} title={QUOTA_BASIS_TOOLTIP}>
                {quotaCell(row.quota)}
              </span>
              <span
                role="cell"
                style={{ ...colNum, ...estCellStyle(colors) }}
                title={
                  row.estimate.tierSource === 'defaulted'
                    ? `${ESTIMATE_BASIS_TOOLTIP}. This dispatch recorded no model, so the ${row.estimate.tier} rate was assumed — if it actually ran on a costlier tier this figure is low.`
                    : `${ESTIMATE_BASIS_TOOLTIP}. Priced at the ${row.estimate.tier} rate.`
                }
              >
                {approxUsd(row.estimate.usdApprox)}
                {/* The Agent tool's `model` is an optional override omitted on
                    most dispatches, so a defaulted tier is the common case, not
                    the edge one. Unmarked, it is a silent ~40% undercount on
                    any run that was really Opus. */}
                {row.estimate.tierSource === 'defaulted' && <span style={assumedStyle(colors)}>?</span>}
              </span>
              {row.exitState === 'ok' && (
                <span role="cell" style={colVerify}>
                  <VerifyWithCodexButton
                    toolUseId={row.toolUseId}
                    // No signal in this renderer for "does this dispatch have
                    // exact file-touch correlation" -- the IPC handler /
                    // CodexVerifier already enforce evidence sufficiency
                    // server-side and return EVIDENCE_INCOMPLETE if missing,
                    // so this is only a UX nicety, not a real gate.
                    evidenceSufficient={true}
                  />
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const cardStyle = (c: ColorPalette): CSSProperties => ({
  background: c.panelGradient,
  border: `1px solid ${c.panelBorder}`,
  borderRadius: 8,
  padding: '14px 16px',
});

const headerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 10,
};

const cardTitleStyle = (c: ColorPalette): CSSProperties => ({
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: '.14em',
  color: c.textSecondary,
});

const sortBtnStyle = (c: ColorPalette): CSSProperties => ({
  font: `500 10px/1 ${fonts.ui}`,
  letterSpacing: '.08em',
  color: c.textSecondary,
  background: c.panelInset,
  border: `1px solid ${c.chipBorder}`,
  borderRadius: 6,
  padding: '4px 8px',
  cursor: 'pointer',
});

const tableStyle: CSSProperties = { display: 'flex', flexDirection: 'column' };

const headRowStyle = (c: ColorPalette): CSSProperties => ({
  display: 'flex',
  gap: 12,
  padding: '0 0 6px',
  borderBottom: `1px solid ${c.chromeBorder}`,
  font: `500 10px/1.4 ${fonts.ui}`,
  letterSpacing: '.08em',
  color: c.textMuted,
});

const bodyRowStyle = (c: ColorPalette, troubled: boolean): CSSProperties => ({
  display: 'flex',
  gap: 12,
  padding: '7px 0',
  borderBottom: `1px solid ${c.chromeBorder}`,
  alignItems: 'baseline',
  // Anomaly-adjacent treatment, matching how the rest of the app marks
  // trouble: a danger-tinted left edge rather than a whole-row colour wash.
  borderLeft: troubled ? `2px solid ${c.danger}` : '2px solid transparent',
  paddingLeft: 8,
  background: troubled ? c.dangerSoft : undefined,
});

const colDesc: CSSProperties = { flex: 1, minWidth: 0 };
const colType: CSSProperties = { width: 120, flexShrink: 0 };
const colNum: CSSProperties = { width: 82, flexShrink: 0, textAlign: 'right' };
const colVerify: CSSProperties = { flexShrink: 0, marginLeft: 4 };

const cellStyle = (c: ColorPalette): CSSProperties => ({
  font: `400 12px/1.4 ${fonts.mono}`,
  color: c.textSecondary,
});

const descCellStyle = (c: ColorPalette): CSSProperties => ({
  font: `400 12px/1.4 ${fonts.ui}`,
  color: c.textBody,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const estCellStyle = (c: ColorPalette): CSSProperties => ({
  font: `500 12px/1.4 ${fonts.mono}`,
  color: c.textPrimary,
});

const assumedStyle = (c: ColorPalette): CSSProperties => ({
  color: c.warn,
  marginLeft: 3,
  cursor: 'help',
});

const flagStyle = (c: ColorPalette): CSSProperties => ({
  font: `600 10px/1 ${fonts.ui}`,
  letterSpacing: '.06em',
  color: c.danger,
  marginLeft: 8,
});

const emptyStyle = (c: ColorPalette): CSSProperties => ({
  font: `400 12px/1.5 ${fonts.ui}`,
  color: c.textDim,
});
