import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { useAetherStore } from '../../state/store';
import { estimateDispatchCost, reconcile, isSameLocalDay, type EstimatedCost } from '../../shared/ledgerMath';
import type { CompletedDispatchUsage } from '../../state/liveAgentsMath';
import { SessionCostCard } from './SessionCostCard';
import { RollupCard } from './RollupCard';
import { CacheImpactCard } from './CacheImpactCard';
import { DispatchCostTable, type DispatchCostRow } from './DispatchCostTable';
import { PricingBasisFooter } from './PricingBasisFooter';
import { usd, approxUsd, ESTIMATE_BASIS_TOOLTIP } from './format';

/**
 * Cost Forensics.
 *
 * The view's claim is deliberately scoped in its own header copy: it reports
 * what was *observed in this machine's Claude Code transcripts*, not "your
 * bill". Spend that never passed through a transcript -- a raw API key billed
 * by something else, the exact shape of both incidents that motivated this
 * stage -- is invisible here. This view narrows the search; it does not close
 * it, and it must never read as authoritative about the account.
 */
export function LedgerView() {
  const colors = useColors();
  const { state } = useAetherStore();
  const ledger = state.ledger;

  const rows = buildDispatchRows(state);

  // The residual is only meaningful when both sides cover the same window.
  // The exact side is today's rollup; the estimated side is today's dispatches,
  // scoped with the same time zone and clock main bucketed with. When today has
  // no observed data at all there is nothing to reconcile against, and the row
  // is omitted rather than reconciling against an assumed zero.
  const todaysRows = ledger
    ? rows.filter((r) => isSameLocalDay(r.startedAt, ledger.timeZone, ledger.computedAtMs))
    : [];
  const todaysEstimates: EstimatedCost[] = todaysRows.map((r) => r.estimate);
  const reconciliation =
    ledger && ledger.rollups.today !== null ? reconcile(ledger.rollups.today, todaysEstimates) : null;

  return (
    <div style={rootStyle}>
      <div style={headerStyle}>
        <div style={titleStyle(colors)}>▤ LEDGER</div>
        <div style={scopeStyle(colors)}>observed in this machine's Claude Code transcripts</div>
      </div>

      {!ledger ? (
        <div style={waitingStyle(colors)}>
          No ledger snapshot yet — this fills in on the next transcript scan.
        </div>
      ) : (
        <>
          <div style={cardsRowStyle}>
            <div style={{ flex: '1 1 320px' }}>
              <SessionCostCard total={ledger.total} tiers={ledger.tiers} />
            </div>
            <div style={{ flex: '1 1 260px' }}>
              {/* Hit rate comes from the snapshot, NOT state.cacheHitRatio:
                  the latter is the live session's ring-buffer ratio, and
                  pairing it with an all-transcripts saving would put two
                  different datasets in one card. */}
              <CacheImpactCard cache={ledger.cache} hitRatio={ledger.cacheHitRate} />
            </div>
          </div>

          <RollupCard rollups={ledger.rollups} />

          <DispatchCostTable rows={rows} />

          {reconciliation !== null && (
            <div style={residualStyle(colors)} title={ESTIMATE_BASIS_TOOLTIP}>
              Today: dispatch estimates account for {approxUsd(reconciliation.attributedUsdApprox)} of the{' '}
              {usd(reconciliation.sessionUsd)} observed;{' '}
              <strong style={residualNumberStyle(colors)}>{approxUsd(reconciliation.residualUsd)}</strong>{' '}
              {reconciliation.residualUsd < 0 ? 'over-attributed' : 'unattributed'}.
            </div>
          )}

          {/* The surviving piece of the declined COST GUARD card. Permanent,
              because "does this app cost me anything" is a question worth
              answering once and for good. */}
          <div style={aetherRowStyle(colors)}>
            <span style={aetherLabelStyle(colors)}>Aether OS itself: {usd(0)}</span>
            <span style={aetherNoteStyle(colors)}>
              no model call sites exist — guaranteed by src/shared/noApiCalls.test.ts, which fails the build if
              one reappears
            </span>
          </div>

          <PricingBasisFooter />
        </>
      )}
    </div>
  );
}

/**
 * The renderer holds dispatch data split across three slices, none of which is
 * a CompletedDispatchUsage on its own:
 *   recentCompletedDispatches -- model, description, subagentType
 *   dispatchUsage             -- tokens, toolUses, durationMs, keyed by id
 *   diagnostics.dispatches    -- the collector's schema-v5 exitState/retries
 * Joining them here keeps estimateDispatchCost next to the row it prices.
 *
 * Exported for testing: the join has real edge cases (a dispatch with no usage
 * recorded yet, telemetry from a pre-v5 collector) and they are worth pinning.
 */
export function buildDispatchRows(state: {
  recentCompletedDispatches: { toolUseId: string; subagentType: string; description: string; startedAt: string; prompt: string; model: string | null }[];
  dispatchUsage: Record<string, { tokens: number; toolUses: number; durationMs: number }>;
  diagnostics: { dispatches: { toolUseId: string; exitState: string | null; retries: number | null }[] } | null;
}): DispatchCostRow[] {
  const telemetry = new Map(state.diagnostics?.dispatches.map((d) => [d.toolUseId, d]) ?? []);

  return state.recentCompletedDispatches.map((d) => {
    const usage = state.dispatchUsage[d.toolUseId];
    const completed: CompletedDispatchUsage = {
      ...d,
      // A dispatch whose completion notification carried no usage estimates at
      // zero rather than being dropped -- the row still tells the operator the
      // dispatch happened, which a missing row would not.
      tokens: usage?.tokens ?? 0,
      toolUses: usage?.toolUses ?? 0,
      durationMs: usage?.durationMs ?? 0,
    };
    const t = telemetry.get(d.toolUseId);
    return {
      toolUseId: d.toolUseId,
      startedAt: d.startedAt,
      description: d.description,
      subagentType: d.subagentType,
      durationMs: completed.durationMs,
      toolUses: completed.toolUses,
      estimate: estimateDispatchCost(completed),
      exitState: (t?.exitState ?? null) as DispatchCostRow['exitState'],
      retries: t?.retries ?? null,
    };
  });
}

const rootStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 16,
  overflowY: 'auto',
  height: '100%',
};

const headerStyle: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' };

const titleStyle = (c: ColorPalette): CSSProperties => ({
  font: `700 16px/1 ${fonts.ui}`,
  letterSpacing: '.16em',
  color: c.accentCyan,
});

const scopeStyle = (c: ColorPalette): CSSProperties => ({
  font: `400 11px/1.4 ${fonts.ui}`,
  color: c.textMuted,
});

const cardsRowStyle: CSSProperties = { display: 'flex', gap: 12, flexWrap: 'wrap' };

const waitingStyle = (c: ColorPalette): CSSProperties => ({
  font: `400 12px/1.6 ${fonts.ui}`,
  color: c.textDim,
  padding: '20px 0',
});

const residualStyle = (c: ColorPalette): CSSProperties => ({
  font: `400 11px/1.6 ${fonts.ui}`,
  color: c.textMuted,
  background: c.panelInset,
  border: `1px solid ${c.chipBorder}`,
  borderRadius: 6,
  padding: '8px 12px',
});

const residualNumberStyle = (c: ColorPalette): CSSProperties => ({
  color: c.warn,
  fontWeight: 600,
});

const aetherRowStyle = (c: ColorPalette): CSSProperties => ({
  display: 'flex',
  gap: 10,
  alignItems: 'baseline',
  flexWrap: 'wrap',
  padding: '8px 12px',
  background: c.panelInset,
  border: `1px solid ${c.chipBorder}`,
  borderRadius: 6,
});

const aetherLabelStyle = (c: ColorPalette): CSSProperties => ({
  font: `600 12px/1.4 ${fonts.mono}`,
  color: c.success,
});

const aetherNoteStyle = (c: ColorPalette): CSSProperties => ({
  font: `400 10px/1.5 ${fonts.ui}`,
  color: c.textDim,
});
