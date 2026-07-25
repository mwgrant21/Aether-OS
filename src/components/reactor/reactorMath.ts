import type { AlarmLevel, ThemeName } from '../../state/types';

const HUE_MAP: Record<ThemeName, number> = { cyan: 0, blue: 30, teal: -25, violet: 75, amber: -150, red: 165 };

const RATE_MIN = 20000;
const RATE_MAX = 168000;
const RATE_IDLE = 92000;

export function computeRateFromUsage(burnRatePerMin: number): number {
  if (burnRatePerMin <= 0) return RATE_IDLE;
  return Math.max(RATE_MIN, Math.min(RATE_MAX, burnRatePerMin));
}

export function computePulseDuration(rate: number, pulseMode: 'live' | 'ambient', alarmLevel: AlarmLevel): number {
  const t = (rate - 28000) / (168000 - 28000);
  let dur = pulseMode === 'ambient' ? 2.4 : 2.9 - t * 2.1;
  if (alarmLevel === 'crit') dur = Math.min(dur, 1.0);
  return dur;
}

const OVERLOAD_HUE_SHIFT = 40;

export function computeThemeHueDeg(theme: ThemeName, alarmLevel: AlarmLevel, overload: boolean = false): number {
  let hueDeg = HUE_MAP[theme] ?? 0;
  if (alarmLevel === 'warn') hueDeg = -150;
  else if (alarmLevel === 'crit') hueDeg = 165;
  if (overload) hueDeg += OVERLOAD_HUE_SHIFT;
  return hueDeg;
}

export function computeThemeFilter(theme: ThemeName, alarmLevel: AlarmLevel, glowFx: boolean, overload: boolean = false): string {
  const hueDeg = computeThemeHueDeg(theme, alarmLevel, overload);
  const overloadBrightness = overload ? ' brightness(1.15)' : '';
  return `hue-rotate(${hueDeg}deg)` + (glowFx === false ? ' saturate(.75) brightness(.92)' : '') + overloadBrightness;
}

export function advancePhase(prevPhase: number, dtSeconds: number, durSeconds: number): number {
  return (prevPhase + dtSeconds / (durSeconds || 2.4)) % 1;
}

export function computeSurge(phase: number): number {
  return Math.exp(-3.5 * phase);
}
