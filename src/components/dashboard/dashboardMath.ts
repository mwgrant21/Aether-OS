import type { AetherState, AlarmLevel, Cfg } from '../../state/types';
import { STATUSLINE_STALE_AFTER_MS } from '../../shared/depletion';
import { fmt, fmtEta, short } from '../../utils/format';

const CONTEXT_WINDOW = 200000;

/** Rendered wherever a readout has no real source. "No data" is never 0. */
export const NO_DATA = '—';

/**
 * The one "a Claude session is live" signal, composed from state that the
 * existing IPC sync hooks already maintain (no channel of its own):
 * - realUsage.burnRatePerMin > 0: tokens landed in a transcript within the
 *   last 10 minutes (useRealUsageSync).
 * - realAgents non-empty AND terminalAlive: a dispatch is running right now
 *   (useRealAgentsSync). realAgents is tailed from the embedded pty's
 *   transcript and is not cleared when that pty exits, so without the
 *   terminalAlive gate a crash mid-dispatch would read as live forever.
 * - a statusline capture younger than STATUSLINE_STALE_AFTER_MS: Claude Code
 *   rendered its status line recently (useStatuslineSync).
 * - a fleet row with status 'busy': the collector sees a Claude session
 *   working (useFleetSync; null whenever the collector is absent or its
 *   heartbeat is stale). An 'idle' row is an open session waiting on input,
 *   which is STANDBY, the same as an idle embedded session.
 * terminalAlive on its own is NOT a signal: a shell being open is not a
 * Claude session. Browser mode (plain vite) has
 * none of these feeds, so it always reads as not live.
 */
export function isSessionLive(state: AetherState, nowMs: number): boolean {
  if (state.realUsage.burnRatePerMin > 0) return true;
  if (state.realAgents.length > 0 && state.terminalAlive) return true;
  if (state.statusline !== null && nowMs - state.statusline.capturedAtMs <= STATUSLINE_STALE_AFTER_MS) return true;
  if (state.fleet !== null && state.fleet.some((row) => row.status === 'busy')) return true;
  return false;
}

/** An alarm always wins; otherwise a quiet console reads STANDBY, not NOMINAL. */
export function computeDashStatus(alarmLevel: AlarmLevel, live: boolean): string {
  if (alarmLevel === 'crit') return 'BURN ALARM';
  if (alarmLevel === 'warn') return 'ELEVATED';
  return live ? 'NOMINAL' : 'STANDBY';
}

/** "cyan core" (or whichever theme) implies something is actually lit; idle must say so instead. */
export function computeDashPulseMode(cfg: Cfg, live: boolean): string {
  const mode = cfg.pulseMode === 'ambient' ? 'ambient pulse' : 'live-rate pulse';
  return `${mode} · ${live ? `${cfg.theme} core` : 'standby'}`;
}

/**
 * The real token rate, from transcripts. state.rate is NOT this: it is the
 * reactor's visual band (computeRateFromUsage), which idles at 92,000 with no
 * usage at all, so it must never be printed as tok/min.
 */
export function computeRateReadout(state: AetherState, live: boolean): string {
  if (!live || state.realUsage.lastScanAt === null) return `${NO_DATA} tok/min`;
  return `${fmt(state.realUsage.burnRatePerMin)} tok/min`;
}

/**
 * Sidebar's compact reactor legend -- same live/scanned gating and source
 * (state.realUsage.burnRatePerMin) as computeRateReadout above, never
 * state.rate, but the sidebar's own compact `short()` presentation rather
 * than computeRateReadout's "N,NNN tok/min" string.
 */
export function computeSidebarReactorRate(state: AetherState, live: boolean): string {
  if (!live || state.realUsage.lastScanAt === null) return NO_DATA;
  return short(state.realUsage.burnRatePerMin);
}

/** Idle must read as idle, not as a stale "nominal" claim with a real agent count. */
export function computeSidebarReactorStatus(live: boolean, agentCount: number): string {
  return live ? `Reactor nominal — ${agentCount} agents drawing power.` : 'Reactor on standby';
}

/**
 * TOKEN USAGE card's range total (BottomMetricsRow). Before the first scan,
 * `values` is initialState's all-zero seed, which would otherwise render a
 * confident "0" indistinguishable from a real zero-usage reading -- NO_DATA
 * instead, matching the rest of the app's no-reading-yet convention.
 */
export function computeUsageRangeTotal(values: readonly number[], scanned: boolean): string {
  if (!scanned) return NO_DATA;
  return fmt(values.reduce((sum, v) => sum + v, 0));
}

export interface UsageBar {
  height: number;
  /** True for a zero-value or pre-scan bar: render flat/dim, not a scaled real reading. */
  baseline: boolean;
}

/**
 * TOKEN USAGE bar height (BottomMetricsRow). The old formula
 * (`20 + (v / maxBar) * 52`) floors EVERY bar at 20px, including zero-value
 * and pre-scan ones, so an unscanned week rendered as 7 solid-looking cyan
 * blocks -- indistinguishable from 7 small real readings. A zero/unscanned
 * bar is a thin flat tick instead; only a real positive reading gets the
 * scaled-height treatment.
 */
export function computeUsageBar(v: number, maxBar: number, scanned: boolean): UsageBar {
  if (!scanned || v <= 0) return { height: 2, baseline: true };
  return { height: Math.round(20 + (v / maxBar) * 52), baseline: false };
}

/**
 * The commands run THIS session, so SESSION INFO's count and TOP COMMANDS read
 * one source. cmdHist persists across restarts and its entries carry no
 * timestamp; commandsRun does not persist, and RUN_COMMAND bumps both in the
 * same step, so the session's commands are exactly the last min(commandsRun, 30)
 * commands of this session.
 */
export function sessionCommandHistory(state: Pick<AetherState, 'cmdHist' | 'commandsRun'>): string[] {
  if (state.commandsRun <= 0) return [];
  return state.cmdHist.slice(-state.commandsRun);
}

export interface DashKpi {
  k: string;
  v: string;
  s: string;
}

export function computeDashKpis(state: AetherState): DashKpi[] {
  // Every tile here derives from the transcript scan; before the first scan
  // lands (and always in browser mode) there is no reading, so render NO_DATA
  // rather than a 0 that reads as "nothing used".
  const scanned = state.realUsage.lastScanAt !== null;
  const capTokens = state.cfg.capM * 1e6;
  const used = state.realUsage.usedThisMonth;
  const budgetLeftPct = Math.max(0, 100 - (used / capTokens) * 100);
  const remaining = Math.max(0, capTokens - used);
  const burn = state.realUsage.burnRatePerMin;
  // An estimate keeps its `~`; with no draw there is nothing to project from.
  const eta = scanned && burn > 0 ? `~${fmtEta(remaining / (burn / 60))}` : NO_DATA;

  return [
    { k: 'MONTH TOKENS', v: scanned ? short(used) : NO_DATA, s: 'this month' },
    { k: 'BUDGET LEFT', v: scanned ? `${budgetLeftPct.toFixed(1)}%` : NO_DATA, s: `of ${state.cfg.capM.toFixed(1)}M cap` },
    { k: 'DEPLETION ETA', v: eta, s: 'at current draw' },
    // Fallback for when no statusline capture exists (ReactorStatusCard's
    // deriveTileOverride supersedes it once one does). ctxUsed is only real
    // once a transcript scan has replaced initialState's seed; 200,000 is the
    // assumed Claude Code window (see commands.ts / issue #20), so this is an
    // estimate and keeps its `~`.
    scanned
      ? { k: 'CONTEXT', v: `~${Math.round((state.ctxUsed / CONTEXT_WINDOW) * 100)}%`, s: `${short(state.ctxUsed)} / 200K` }
      : { k: 'CONTEXT', v: NO_DATA, s: 'no reading yet' },
  ];
}
