// Layer 0 data contract for the Agent Personality Layer, ported verbatim from
// docs/superpowers/specs/AGENT_PERSONALITY_LAYER_1.md §3 (types) and §4
// (computeSeverity derivation rules).
//
// Stage 11 (this file's first consumer) only ever writes `severity` via
// computeSeverity with `findingWeights` omitted (or empty) and
// `medianMsAtEval: null` — see docs/superpowers/specs/2026-07-31-narration-spine-stage11-design.md's
// field-mapping table. `findings`/`revision`/`decision`/`narration` are
// declared here as types but are NOT populated by real Stage 11 data; they
// exist so Tasks 4/5 (and later Stage 12/13) have a stable contract to grow
// into without a breaking type change.
//
// RevisionCause is imported, not restated: memoryStore.ts (Layer 2) declares
// the canonical union and this file's Revision.cause uses it directly, so
// there is exactly one declaration of what a revision cause is, not two
// independently-maintained copies. See docs/roadmap.md §3.3's Stage 13
// paragraph for why this was worth calling out.

import type { RevisionCause } from './memoryStore.js';

export type Severity = 0 | 1 | 2 | 3 | 4;

export type ExitState =
  | 'ok'
  | 'partial'
  | 'error' // failed, recoverable
  | 'fatal' // failed, unrecoverable — no signal available
  | 'timeout'
  | 'blocked'; // needs a decision only Matt can make

export interface AgentEnvelope<T> {
  // ---- IDENTITY ----
  agent_id: string;
  run_id: string;
  task_kind: string; // REQUIRED — baselines are keyed on this

  // ---- WORK CHANNEL — Pass 1. No voice instruction in context. ----
  result: T; // schema-validated, voice-free
  findings?: Finding[];
  revision?: Revision; // §7 — a checkable fact, not prose
  decision?: DecisionRequest; // §5.8, §9 — structured handoff

  // ---- NARRATION CHANNEL — Pass 2. Voice lives here and nowhere else. ----
  narration: string | null; // null = deliberate silence (!= empty string)

  // ---- TELEMETRY — runtime writes; agent never does ----
  telemetry: {
    started_at: number;
    elapsed_ms: number;
    retries: number;
    tokens: number;
    exit: ExitState;
    median_ms_at_eval: number | null; // snapshot — makes severity reproducible
    severity: Severity; // computed, stored
  };
}

export interface Finding {
  id: string;
  file?: string;
  line?: number;
  claim: string; // neutral prose, no voice
  evidence: string; // what makes it true
  weight: Severity; // assessment of the CODE (see P1 scope note)
}

export interface Revision {
  finding_id: string;
  cause: RevisionCause;
  detail: string; // the specific fact or flaw
}

export interface DecisionRequest {
  fork: string; // the actual question, one line
  options: string[];
  if_nothing: string; // consequence of not deciding
  reason: string; // <= 200 chars — rendered in voice, capped
}

/**
 * Deterministic severity derivation, ported verbatim from §4's pseudocode.
 *
 * Deliberately does NOT implement an "sev = 0 / no active run" branch: per §4,
 * that is a UI-only concept ("idle... renders as absence, not silence") for
 * when there is no run at all. Stage 11 (and every caller of this function)
 * always has a concrete run with a `telemetry` row to evaluate, so that branch
 * has no meaningful input here and would just be dead code guarded by nothing.
 *
 * Order matters and must not be reordered: the retries/median `+=` bumps are
 * applied BEFORE the exit-state and finding-weight `max()` calls, exactly as
 * the spec's pseudocode orders them. Swapping the order can change the result
 * for combinations like `retries>=2` with `exit:'partial'`.
 */
export function computeSeverity(input: {
  exit: ExitState;
  retries: number;
  elapsedMs: number;
  medianMsAtEval: number | null;
  findingWeights?: Severity[];
}): Severity {
  const { exit, retries, elapsedMs, medianMsAtEval, findingWeights = [] } = input;

  let sev = 1;

  if (medianMsAtEval !== null && elapsedMs > 3 * medianMsAtEval) {
    sev += 1;
  }
  if (retries >= 2) {
    sev += 1;
  }

  if (exit === 'partial') sev = Math.max(sev, 2);
  if (exit === 'error') sev = Math.max(sev, 3);
  if (exit === 'timeout') sev = Math.max(sev, 3);
  if (exit === 'fatal') sev = Math.max(sev, 4);
  if (exit === 'blocked') sev = 4;

  if (findingWeights.some((w) => w === 3)) sev = Math.max(sev, 3);
  if (findingWeights.some((w) => w === 4)) sev = Math.max(sev, 4);

  sev = Math.min(4, Math.max(0, sev));

  return sev as Severity;
}
