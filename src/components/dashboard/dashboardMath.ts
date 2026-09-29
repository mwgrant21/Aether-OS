import type { AetherState, AlarmLevel, Cfg } from '../../state/types';
import { STATUSLINE_STALE_AFTER_MS } from '../../shared/depletion';
import type { StatuslineSnapshot } from '../../shared/statuslinePayload';
import { fmt, fmtEta, formatUptime, short } from '../../utils/format';
import { deriveContextWindowCard } from '../layout/contextWindowCard';
import { isSameLocalDay, type LedgerSnapshot } from '../../shared/ledgerMath';
import { usdPrecise } from '../ledger/format';

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

/**
 * Live: which pulse the reactor follows and which core is lit. Idle: just
 * "standby" -- "live-rate pulse" beside "standby" contradicted itself.
 */
export function computeDashPulseMode(cfg: Cfg, live: boolean): string {
  if (!live) return 'standby';
  const mode = cfg.pulseMode === 'ambient' ? 'ambient pulse' : 'live-rate pulse';
  return `${mode} · ${cfg.theme} core`;
}

/** The line under the reactor. Idle it reads exactly "— tok/min · standby". */
export function computeRateLine(state: AetherState, live: boolean): string {
  return `${computeRateReadout(state, live)} · ${computeDashPulseMode(state.cfg, live)}`;
}

/**
 * Glow-Is-State for the reactor card's and the footer's status dots: lit
 * while a session is live or an alarm is up, flat at STANDBY. One gate, so
 * the two dots cannot disagree.
 */
export function statusDotGlows(alarmLevel: AlarmLevel, live: boolean): boolean {
  return live || alarmLevel !== 'ok';
}

/**
 * The TODAY tile: today's cost at published API rates (ledger.rollups.today).
 * Exact to the pricing table, so no `~`. `null` (no priced activity observed)
 * is NO_DATA, never "$0.00"; a real zero day prints "$0.00". A snapshot
 * computed on an earlier local day is not today's figure, so it is NO_DATA too.
 */
export function computeTodayCost(ledger: LedgerSnapshot | null, nowMs: number): string {
  if (ledger === null || ledger.rollups.today === null) return NO_DATA;
  if (!isSameLocalDay(new Date(ledger.computedAtMs).toISOString(), ledger.timeZone, nowMs)) return NO_DATA;
  return usdPrecise(ledger.rollups.today);
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

export function computeDashKpis(state: AetherState, nowMs: number = Date.now()): DashKpi[] {
  // MONTH TOKENS, DEPLETION ETA and BUDGET LEFT derive from the transcript scan; before the first scan lands (and always in browser mode) there is no reading, so render NO_DATA rather than a 0 that reads as "nothing used". TODAY reads the ledger.
  const scanned = state.realUsage.lastScanAt !== null;
  const capTokens = state.cfg.capM * 1e6;
  const used = state.realUsage.usedThisMonth;
  const budgetLeftPct = Math.max(0, 100 - (used / capTokens) * 100);
  const remaining = Math.max(0, capTokens - used);
  const burn = state.realUsage.burnRatePerMin;
  // An estimate keeps its `~`; with no draw there is nothing to project from.
  // A cap already spent is a fact, not a projection: fmtEta(0) would return
  // 'n/a', which rendered as the "~n/a" readout.
  const eta = !scanned || burn <= 0 ? NO_DATA : remaining <= 0 ? 'now' : `~${fmtEta(remaining / (burn / 60))}`;

  return [
    { k: 'MONTH TOKENS', v: scanned ? short(used) : NO_DATA, s: 'this month' },
    { k: 'DEPLETION ETA', v: eta, s: 'at current draw' },
    // Context moved to the bottom row's CONTEXT WINDOW card (the one source).
    { k: 'TODAY', v: computeTodayCost(state.ledger, nowMs), s: 'API rate, not paid' },
    { k: 'BUDGET LEFT', v: scanned ? `${budgetLeftPct.toFixed(1)}%` : NO_DATA, s: `of ${state.cfg.capM.toFixed(1)}M cap` },
  ];
}

export interface ContextReading {
  /** Clamped to 0-100: a ratio past full is a data defect, not a reading. */
  pct: number;
  /** The rendered percentage; `~` only when the statusline capture is stale. */
  pctLabel: string;
  /** Used tokens over the payload's own window size, e.g. "480.0K / 1.00M". */
  usedLabel: string;
  stale: boolean;
}

/**
 * The one context-window reading, shared by the dashboard CONTEXT tile and the
 * footer's CONTEXT WINDOW card. It comes from Claude Code's statusline payload
 * (contextUsedPercentage and contextWindowSize) via deriveContextWindowCard,
 * so it is a measured value, not an estimate. The tile used to divide the
 * transcript-derived ctxUsed by an assumed 200K window, which rendered
 * "~245%" on a 1M-context session while this card read 48%.
 */
export function computeContextReading(snap: StatuslineSnapshot | null, nowMs: number): ContextReading | null {
  const card = deriveContextWindowCard(snap, nowMs);
  if (!card.available || card.pct === null || card.usedTokens === null) return null;
  const pct = Math.max(0, Math.min(100, card.pct));
  const used = short(card.usedTokens);
  return {
    pct,
    pctLabel: `${card.stale ? '~' : ''}${Math.round(pct)}%`,
    usedLabel: card.windowSize === null ? used : `${used} / ${short(card.windowSize)}`,
    stale: card.stale,
  };
}

export interface SessionInfoRow {
  k: string;
  v: string;
}

/**
 * SESSION INFO rows (BottomMetricsRow). There is no "Tokens used" row: state
 * holds no session-scoped token total (realUsage.usedThisMonth is the month,
 * already shown as MONTH TOKENS), and a month figure under "Session info"
 * misreports it.
 */
export function computeSessionInfoRows(
  state: Pick<AetherState, 'sessionStartedAt' | 'commandsRun' | 'realAgents'>,
  now: Date,
): SessionInfoRow[] {
  return [
    { k: 'Session start', v: new Date(state.sessionStartedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) },
    { k: 'Uptime', v: formatUptime(state.sessionStartedAt, now) },
    { k: 'Commands run', v: fmt(state.commandsRun) },
    { k: 'Agents active', v: String(state.realAgents.length) },
  ];
}
