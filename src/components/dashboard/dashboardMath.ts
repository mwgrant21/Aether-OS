import type { AetherState, AlarmLevel, Cfg } from '../../state/types';
import { fmtEta, short } from '../../utils/format';

export function computeDashStatus(alarmLevel: AlarmLevel): string {
  if (alarmLevel === 'crit') return 'BURN ALARM';
  if (alarmLevel === 'warn') return 'ELEVATED';
  return 'NOMINAL';
}

export function computeDashPulseMode(cfg: Cfg): string {
  const mode = cfg.pulseMode === 'ambient' ? 'ambient pulse' : 'live-rate pulse';
  return `${mode} · ${cfg.theme} core`;
}

export interface DashKpi {
  k: string;
  v: string;
  s: string;
}

export function computeDashKpis(state: AetherState): DashKpi[] {
  const capTokens = state.cfg.capM * 1e6;
  const used = state.realUsage.usedThisMonth;
  const budgetLeftPct = Math.max(0, 100 - (used / capTokens) * 100);
  const remaining = Math.max(0, capTokens - used);
  // 200,000 is the real Claude Code context window (see commands.ts's
  // formatContextLine / issue #20) -- this fallback only renders before the
  // first statusline snapshot arrives (see ReactorStatusCard's
  // deriveTileOverride), so it must use the same real window size the live
  // reading uses rather than a stale constant.
  const CONTEXT_WINDOW = 200000;
  const ctxPct = Math.round((state.ctxUsed / CONTEXT_WINDOW) * 100);

  return [
    { k: 'SESSION TOKENS', v: short(used), s: 'this month' },
    { k: 'BUDGET LEFT', v: `${budgetLeftPct.toFixed(1)}%`, s: `of ${state.cfg.capM.toFixed(1)}M cap` },
    { k: 'DEPLETION ETA', v: fmtEta(remaining / (state.realUsage.burnRatePerMin / 60)), s: 'at current draw' },
    { k: 'CONTEXT', v: `${ctxPct}%`, s: `${short(state.ctxUsed)} / 200K` },
  ];
}
