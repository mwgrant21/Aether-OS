import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { useAetherStore } from '../../state/store';
import {
  estimateDispatchCost,
  reconcile,
  localDayBoundsMs,
  type EstimatedCost,
  type LedgerSnapshot,
} from '../../shared/ledgerMath';
import type { CompletedDispatchUsage } from '../../state/liveAgentsMath';
import { findProjectByKey } from '../projects/projectsMath';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';
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
  const { ledger, showDispatchDetail } = resolveLedgerViewData(state);

  const rows = buildDispatchRows(state);

  // The residual is only meaningful when both sides cover the same window.
  // The exact side is today's rollup, built (bucketByDay) from each assistant
  // event's OWN timestamp -- not from any dispatch's startedAt. A dispatch
  // that starts before local midnight and finishes after it therefore has
  // events landing in both calendar days' exact totals, even though its
  // *estimate* is one row. Filtering solely on startedAt would drop that
  // row entirely from "today" while some of its exact usage still counted
  // toward today's rollup (or the reverse), misrepresenting the
  // reconciliation. Testing INTERVAL OVERLAP against today's local-day
  // boundaries -- rather than "startedAt OR endedAt falls on today" -- keeps
  // the row in the comparison whenever any of its usage could have landed in
  // today's exact total, including a dispatch that starts before local
  // midnight and doesn't finish until after the FOLLOWING local midnight:
  // neither endpoint is "today", but the interval still fully contains it.
  // Checking only the two endpoints missed that case. This still isn't exact
  // (a spanning dispatch's single estimate isn't split proportionally across
  // the days it touches), but it is the accurate inclusion test, and the
  // residual caveat text below already tells the operator these are
  // approximate, tracked-dispatch figures.
  const todaysRows = selectTodaysRows(rows, ledger);
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

          {showDispatchDetail && <DispatchCostTable rows={rows} />}

          {showDispatchDetail && reconciliation !== null && (
            <div style={residualStyle(colors)} title={ESTIMATE_BASIS_TOOLTIP}>
              Today: {todaysRows.length} tracked dispatch{todaysRows.length === 1 ? '' : 'es'} account for{' '}
              {approxUsd(reconciliation.attributedUsdApprox)} of the {usd(reconciliation.sessionUsd)} observed;{' '}
              {/* Magnitude only -- the label carries the direction. Printing the
                  sign here produced "~$-11.10 over-attributed", a malformed
                  figure and a double negative. */}
              <strong style={residualNumberStyle(colors)}>
                {approxUsd(Math.abs(reconciliation.residualUsd))}
              </strong>{' '}
              {reconciliation.residualUsd < 0 ? 'over-attributed' : 'unattributed'}.{' '}
              <span style={residualCaveatStyle(colors)}>
                Only dispatches this app tracked live are counted, most recent {DISPATCH_HISTORY_CAP} — anything
                older or from another session lands in the unattributed figure rather than being estimator error.
              </span>
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

          {!showDispatchDetail && (
            <div style={residualCaveatStyle(colors)}>
              Dispatch-level detail is only available for the unscoped view — Aether's live
              dispatch tracking follows this session, not any specific project.
            </div>
          )}

          <PricingBasisFooter />
        </>
      )}
    </div>
  );
}

/**
 * Resolves which ledger to render and whether the dispatch-level detail
 * (DispatchCostTable, the reconciliation strip) is safe to show.
 *
 * Dispatch detail is Aether's-own-live-session tracking (recentCompletedDispatches
 * / dispatchUsage / diagnostics) -- it carries no project attribution, so
 * showing it next to a SCOPED ledger.rollups.today would compare a
 * project-scoped exact total against unscoped dispatch estimates, producing
 * a misleading residual. It is suppressed whenever a scope is active, not
 * re-filtered -- there is nothing in that data to filter on.
 */
export function resolveLedgerViewData(state: {
  selectedProject: string | null;
  projectsSnapshot: ProjectsSnapshot | null;
  ledger: LedgerSnapshot | null;
}): { ledger: LedgerSnapshot | null; showDispatchDetail: boolean } {
  const scoped = findProjectByKey(state.projectsSnapshot, state.selectedProject);
  if (scoped) return { ledger: scoped.ledger, showDispatchDetail: false };
  return { ledger: state.ledger, showDispatchDetail: true };
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
    // Derived, not persisted: startedAt + the completed dispatch's own
    // duration. Falls back to startedAt (an instant, not a span) when
    // durationMs or startedAt itself is unavailable/unparsable, so a
    // dispatch missing usage still participates in the "starts today"
    // half of the spans-today test rather than being silently dropped.
    const startedMs = new Date(d.startedAt).getTime();
    const endedAt =
      !Number.isNaN(startedMs) && completed.durationMs > 0
        ? new Date(startedMs + completed.durationMs).toISOString()
        : d.startedAt;
    return {
      toolUseId: d.toolUseId,
      startedAt: d.startedAt,
      endedAt,
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

/**
 * Which dispatch rows count toward "today" for the reconciliation strip.
 *
 * Exported for testing: a dispatch that starts before local midnight and
 * finishes after it (or vice versa) must not be silently excluded from --
 * or silently fully included in -- "today" while the exact rollup it is
 * compared against is built from per-event timestamps that may straddle the
 * boundary differently. Uses interval overlap against today's local-day
 * bounds rather than checking only the two endpoints, so a dispatch that
 * spans the ENTIRE day (starts before today, ends after today) is still
 * caught -- neither of its endpoints is "today" in that case. See the
 * comment at the call site for the full reasoning.
 */
export function selectTodaysRows(
  rows: DispatchCostRow[],
  ledger: { timeZone: string; computedAtMs: number } | null,
): DispatchCostRow[] {
  if (!ledger) return [];
  const { startMs, endMs } = localDayBoundsMs(ledger.timeZone, ledger.computedAtMs);
  return rows.filter((r) => {
    const startedMs = new Date(r.startedAt).getTime();
    const endedMs = new Date(r.endedAt).getTime();
    if (Number.isNaN(startedMs) || Number.isNaN(endedMs)) return false;
    return startedMs <= endMs && endedMs >= startMs;
  });
}

// Mirrors the slice(0, 20) cap in reducer.ts's SET_REAL_AGENTS case.
const DISPATCH_HISTORY_CAP = 20;

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

const residualCaveatStyle = (c: ColorPalette): CSSProperties => ({
  color: c.textDim,
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
