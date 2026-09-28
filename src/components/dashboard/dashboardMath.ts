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
 * - realAgents non-empty: a dispatch is running right now (useRealAgentsSync).
 * - a statusline capture younger than STATUSLINE_STALE_AFTER_MS: Claude Code
 *   rendered its status line recently (useStatuslineSync).
 * - fleet rows present: the collector sees a running Claude session
 *   (useFleetSync; null whenever the collector is absent or its heartbeat is
 *   stale).
 * The embedded terminal's pty (terminalAlive) is deliberately NOT a signal:
 * a shell being open is not a Claude session. Browser mode (plain vite) has
 * none of these feeds, so it always reads as not live.
 */
export function isSessionLive(state: AetherState, nowMs: number): boolean {
  if (state.realUsage.burnRatePerMin > 0) return true;
  if (state.realAgents.length > 0) return true;
  if (state.statusline !== null && nowMs - state.statusline.capturedAtMs <= STATUSLINE_STALE_AFTER_MS) return true;
  if (state.fleet !== null && state.fleet.length > 0) return true;
  return false;
}

/** An alarm always wins; otherwise a quiet console reads STANDBY, not NOMINAL. */
export function computeDashStatus(alarmLevel: AlarmLevel, live: boolean): string {
  if (alarmLevel === 'crit') return 'BURN ALARM';
  if (alarmLevel === 'warn') return 'ELEVATED';
  return live ? 'NOMINAL' : 'STANDBY';
}

export function computeDashPulseMode(cfg: Cfg): string {
  const mode = cfg.pulseMode === 'ambient' ? 'ambient pulse' : 'live-rate pulse';
  return `${mode} · ${cfg.theme} core`;
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
