// GENERATED from electron/severity/computeSeverity.ts by scripts/sync-severity-core.mjs -- do not edit.
// Edit the electron copy, then run: node scripts/sync-severity-core.mjs
// electron/severity/computeSeverity.ts
// Pure severity derivation. Amends AGENT_PERSONALITY_LAYER_1.md section 4 per
// docs/superpowers/specs/2026-09-30-real-severity-design.md section 3:
//   failed -> error/4, killed -> killed/2 (never above 2), stalled -> fatal/4,
//   unknown -> ok/1, slowness alone capped at 2, retries rule removed (no source).
//
// SOURCE OF TRUTH for collector/src/severity/computeSeverity.ts, which
// scripts/sync-severity-core.mjs generates. Edit here, then re-run it.

import type { DispatchStatus } from './parseDispatchOutcome.js';

export type Severity = 0 | 1 | 2 | 3 | 4;

export type ExitState =
  | 'ok'
  | 'partial' // unused: nothing produces it yet
  | 'error' // <status>failed</status>
  | 'fatal' // stalled: no progress past STALL_MS, or the owning session ended
  | 'timeout' // unused: nothing produces it yet
  | 'blocked' // unused: nothing produces it yet
  | 'killed'; // <status>killed</status>: almost always a deliberate stop

export const SLOW_FACTOR = 3;
export const SLOWNESS_CAP = 2;

export interface SeverityInput {
  exit: ExitState;
  elapsedMs: number;
  medianMsAtEval: number | null;
  findingWeights?: readonly Severity[];
}

export interface SeverityResult {
  severity: Severity;
  exitState: ExitState;
  elapsedMs: number;
  medianMs: number | null;
}

export function exitStateForStatus(status: DispatchStatus): ExitState {
  if (status === 'failed') return 'error';
  if (status === 'killed') return 'killed';
  return 'ok';
}

export function computeSeverity(input: SeverityInput): SeverityResult {
  const { exit, elapsedMs, findingWeights = [] } = input;
  const m = input.medianMsAtEval;
  const medianMs = typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : null;

  let sev = 1;
  if (medianMs !== null && Number.isFinite(elapsedMs) && elapsedMs > SLOW_FACTOR * medianMs) {
    sev = Math.min(sev + 1, SLOWNESS_CAP);
  }

  if (exit === 'partial') sev = Math.max(sev, 2);
  if (exit === 'timeout') sev = Math.max(sev, 3);
  if (exit === 'error') sev = Math.max(sev, 4);
  if (exit === 'fatal') sev = Math.max(sev, 4);
  if (exit === 'blocked') sev = 4;

  if (findingWeights.some((w) => w === 3)) sev = Math.max(sev, 3);
  if (findingWeights.some((w) => w === 4)) sev = Math.max(sev, 4);

  // Last on purpose: a kill is informational and must never reach the
  // severity >= 3 floor (dial bypass, voice), whatever else is true.
  if (exit === 'killed') sev = 2;

  sev = Math.min(4, Math.max(0, sev));
  return { severity: sev as Severity, exitState: exit, elapsedMs, medianMs };
}
