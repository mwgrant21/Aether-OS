import type { AlarmLevel, ThemeName } from '../../state/types';

const HUE_MAP: Record<ThemeName, number> = { cyan: 0, blue: 30, teal: -25, violet: 75, amber: -150, red: 165 };

const RATE_MIN = 20000;
const RATE_MAX = 168000;
const RATE_IDLE = 92000;

export interface RateSample {
  burnRatePerMin: number;
  atMs: number;
}

const MOMENTUM_WINDOW = 3;
// tokens/min delta across the window that reads as the max visual rise/fall; a starting
// point, adjustable later without architectural change (same posture as REAL_BURN_CEILING
// before it).
const MOMENTUM_RANGE = 6000;

export function computeMomentum(history: RateSample[]): number {
  if (history.length < MOMENTUM_WINDOW) return RATE_IDLE;
  const window = history.slice(-MOMENTUM_WINDOW);
  const delta = window[window.length - 1].burnRatePerMin - window[0].burnRatePerMin;
  const clamped = Math.max(-MOMENTUM_RANGE, Math.min(MOMENTUM_RANGE, delta));
  if (clamped >= 0) return Math.round(RATE_IDLE + (clamped / MOMENTUM_RANGE) * (RATE_MAX - RATE_IDLE));
  return Math.round(RATE_IDLE + (clamped / MOMENTUM_RANGE) * (RATE_IDLE - RATE_MIN));
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

export function computeThemeFilter(theme: ThemeName, alarmLevel: AlarmLevel, glowFx: boolean, overload: boolean = false, modelHueShift: number = 0): string {
  let hueDeg = computeThemeHueDeg(theme, alarmLevel, overload);
  hueDeg += modelHueShift;
  const overloadBrightness = overload ? ' brightness(1.15)' : '';
  return `hue-rotate(${hueDeg}deg)` + (glowFx === false ? ' saturate(.75) brightness(.92)' : '') + overloadBrightness;
}

const CACHE_CLARITY_MIN = 0.6;

export function computeCacheClarity(cacheHitRatio: number): number {
  const t = Math.max(0, Math.min(1, cacheHitRatio));
  return CACHE_CLARITY_MIN + t * (1 - CACHE_CLARITY_MIN);
}

const TURBULENCE_SATURATION_COUNT = 4; // realAgentCount at/above this reads as maximum turbulence

export function computeConcurrencyTurbulence(realAgentCount: number): number {
  return Math.max(0, Math.min(1, realAgentCount / TURBULENCE_SATURATION_COUNT));
}

export function dominantModel(realAgents: { model: string | null }[]): string | null {
  const counts = new Map<string, number>();
  for (const a of realAgents) {
    if (!a.model) continue;
    counts.set(a.model, (counts.get(a.model) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [model, count] of counts) {
    if (count > bestCount) { best = model; bestCount = count; }
  }
  return best;
}

// Model name substrings, checked in this order (first match wins) -- real
// model identifiers look like "claude-haiku-4-5-..."/"claude-sonnet-5"/etc.
const MODEL_HUE_SHIFTS: [substring: string, shiftDeg: number][] = [
  ['haiku', -60],   // cool blue
  ['opus', 90],     // violet
  ['fable', 200],   // gold
  // sonnet and anything unrecognized: no shift (0), sonnet is the visual default
];

export function computeModelHueShift(model: string | null): number {
  if (!model) return 0;
  const lower = model.toLowerCase();
  for (const [substring, shift] of MODEL_HUE_SHIFTS) {
    if (lower.includes(substring)) return shift;
  }
  return 0;
}

export function advancePhase(prevPhase: number, dtSeconds: number, durSeconds: number): number {
  return (prevPhase + dtSeconds / (durSeconds || 2.4)) % 1;
}

export function computeSurge(phase: number): number {
  return Math.exp(-3.5 * phase);
}

export interface DispatchIntensity {
  overdrive: boolean;
  overload: boolean;
  glowMultiplier: number;
}

export function computeDispatchIntensity(realAgentCount: number): DispatchIntensity {
  const overdrive = realAgentCount >= 2;
  const overload = realAgentCount >= 3;
  return { overdrive, overload, glowMultiplier: overload ? 1.25 : 1 };
}
