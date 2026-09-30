// Layer 0 data contract for the Agent Personality Layer, ported verbatim from
// docs/superpowers/specs/AGENT_PERSONALITY_LAYER_1.md §3 (types).
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
//
// computeSeverity moved to ./severity/computeSeverity.js (generated from electron/severity/) -- spec 2026-09-30-real-severity-design.md section 4.

import type { RevisionCause } from './memoryStore.js';

import type { Severity, ExitState } from './severity/computeSeverity.js';
export type { Severity, ExitState } from './severity/computeSeverity.js';

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
