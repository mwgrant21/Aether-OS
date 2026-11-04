import type { StatuslineSnapshot } from '../statuslinePayload';
import type { LaunchEffort, ModelAlias, Pick } from './types';

export type UsageReading = { sessionPct: number; weekPct: number; known: boolean };

/**
 * Usage from a statusline snapshot. A null, stale or window-less snapshot reads
 * 0 for the missing field; `known` is false when neither window is usable, so
 * the caller takes no budget action on it.
 */
export function usageFromSnapshot(
  s: StatuslineSnapshot | null,
  nowMs: number,
  maxAgeMs = 15 * 60_000,
): UsageReading {
  if (!s || nowMs - s.capturedAtMs > maxAgeMs) return { sessionPct: 0, weekPct: 0, known: false };
  const sessionPct = s.fiveHour ? s.fiveHour.usedPercentage : 0;
  const weekPct = s.sevenDay ? s.sevenDay.usedPercentage : 0;
  return { sessionPct, weekPct, known: s.fiveHour !== null || s.sevenDay !== null };
}

const ALIAS_RE = /haiku|sonnet|opus/i;

/** Model alias read from either statusline field; other non-empty values are 'other'. */
export function aliasFromModel(s: {
  modelId: string | null;
  modelDisplayName: string | null;
}): ModelAlias | 'other' | null {
  let sawValue = false;
  for (const v of [s.modelId, s.modelDisplayName]) {
    if (!v || !v.trim()) continue;
    sawValue = true;
    const m = ALIAS_RE.exec(v);
    if (m) return m[0].toLowerCase() as ModelAlias;
  }
  return sawValue ? 'other' : null;
}

export type Readback = {
  model: ModelAlias | 'other' | null;
  effort: LaunchEffort | null;
  capturedAtMs: number;
};

export type Judgement = {
  kind: 'confirmed' | 'not-applied' | 'pending' | 'unconfirmed';
  actual: Pick | null;
};

export function judgeReadback(args: {
  wanted: Pick;
  readback: Readback | null;
  sentAtMs: number;
  nowMs: number;
  timeoutMs?: number;
  onTimeout?: 'unconfirmed' | 'not-applied';
}): Judgement {
  const { wanted, readback, sentAtMs, nowMs } = args;
  const timeoutMs = args.timeoutMs ?? 60_000;
  const onTimeout = args.onTimeout ?? 'unconfirmed';

  // A snapshot captured before the write was sent can never confirm it.
  const usable = readback && readback.capturedAtMs >= sentAtMs && readback.model !== null ? readback : null;

  if (usable) {
    const actual: Pick | null =
      usable.model !== 'other' && usable.model !== null && usable.effort !== null
        ? { model: usable.model, effort: usable.effort }
        : null;
    if (usable.model !== wanted.model) return { kind: 'not-applied', actual };
    if (usable.effort === null) return { kind: 'unconfirmed', actual: null };
    if (usable.effort !== wanted.effort) return { kind: 'not-applied', actual };
    return { kind: 'confirmed', actual };
  }

  if (nowMs - sentAtMs >= timeoutMs) return { kind: onTimeout, actual: null };
  return { kind: 'pending', actual: null };
}
