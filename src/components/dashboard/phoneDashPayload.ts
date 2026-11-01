// Builds the phone `dash` view payload (privacy section 17) in the renderer, from the same pure functions the Dashboard
// draws from, so the phone cannot disagree with the desktop about live/standby, the ETA or the readiness rows. Scalars,
// enums and counts only: no readiness or KPI copy (the phone owns its strings), no digest rows, no alert text, no
// command history, no cfg object (capM only). Main re-validates it in encodeDashView.
import type { AetherState } from '../../state/types';
import { deriveDepletion } from '../../shared/depletion';
import { isSameLocalDay } from '../../shared/ledgerMath';
import { isSessionLive } from './dashboardMath';
import { computeDigestPresence, computeReadiness, computeStripItems, newestCollectorEventMs, type ReadinessKey } from './readinessMath';

const nonNeg = (n: number): number => (Number.isFinite(n) ? Math.max(0, n) : n);

function todayUsd(state: AetherState, nowMs: number): number | null {
  const l = state.ledger;
  if (l === null || l.rollups.today === null) return null;
  if (!isSameLocalDay(new Date(l.computedAtMs).toISOString(), l.timeZone, nowMs)) return null;
  return l.rollups.today;
}

/** Same precedence as the REACTOR STATUS card: a statusline reading wins, else the transcript-scan estimate. */
function eta(state: AetherState, nowMs: number, scanned: boolean, remaining: number): Record<string, unknown> {
  const d = deriveDepletion(state.statusline, null, nowMs);
  if (d.source === 'statusline') {
    const ms = d.msUntilDepleted;
    return {
      kind: ms === null ? 'none' : ms <= 0 ? 'now' : 'secs',
      secs: ms === null || ms <= 0 ? null : Math.round(ms / 1000),
      source: d.stale ? 'stale' : 'live',
      resetsInMs: d.msUntilReset === null ? null : Math.round(nonNeg(d.msUntilReset)),
    };
  }
  const burn = state.realUsage.burnRatePerMin;
  if (!scanned || !(burn > 0)) return { kind: 'none', secs: null, source: 'scan', resetsInMs: null };
  if (remaining <= 0) return { kind: 'now', secs: null, source: 'scan', resetsInMs: null };
  return { kind: 'secs', secs: Math.round(remaining / (burn / 60)), source: 'scan', resetsInMs: null };
}

/**
 * `desktop` is whether the Electron bridge exists (hasDesktopApp()); nowMs is the publish instant and is sent as
 * computedAtMs so the phone can show how old the reading is (live/standby and the ETA are judged at this instant and are
 * not re-judged until the next publish).
 */
export function phoneDashPayload(state: AetherState, desktop: boolean, nowMs: number): Record<string, unknown> {
  const live = isSessionLive(state, nowMs);
  const scanned = state.realUsage.lastScanAt !== null;
  const capTokens = state.cfg.capM * 1e6;
  const used = state.realUsage.usedThisMonth;
  const rows = computeReadiness(state, desktop, nowMs);
  const atMs: Record<ReadinessKey, number | null> = {
    desktop: null,
    terminal: state.terminalAlive ? state.terminalOpenedAtMs : null,
    statusline: state.statusline?.capturedAtMs ?? null,
    collector: desktop && state.diagnostics !== null ? newestCollectorEventMs(state.diagnostics) : null,
  };
  const presence = computeDigestPresence(state);
  const memory = computeStripItems(presence, state.memories.length).find((i) => i.key === 'memory')?.count ?? state.memories.length;
  const entries = state.recap?.entries ?? [];
  return {
    computedAtMs: nowMs,
    live,
    alarm: state.alarmLevel,
    ratePerMin: live && scanned ? state.realUsage.burnRatePerMin : null,
    kpis: {
      monthTokens: scanned ? used : null,
      todayUsd: todayUsd(state, nowMs),
      budgetLeftPct: scanned ? Math.max(0, 100 - (used / capTokens) * 100) : null,
      capM: state.cfg.capM,
      eta: eta(state, nowMs, scanned, Math.max(0, capTokens - used)),
    },
    readiness: rows.map((r) => ({ key: r.key, met: r.met, glows: r.glows, atMs: atMs[r.key] })),
    recap:
      state.recap === null
        ? null
        : {
            dispatches: entries.filter((e) => e.kind === 'dispatchCompleted').length,
            anomaliesDetected: entries.filter((e) => e.kind === 'anomalyDetected').length,
            anomaliesCleared: entries.filter((e) => e.kind === 'anomalyCleared').length,
            tokensBurned: state.recap.tokensBurned,
          },
    strip: { agents: presence.agents ? state.realAgents.length : 0, alerts: state.notifs.length, memory },
  };
}
