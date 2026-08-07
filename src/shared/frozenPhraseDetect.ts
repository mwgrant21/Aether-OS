/**
 * Detect the four frozen-phrase event kinds.
 *
 * Closes the Stage 12 open item from docs/roadmap.md row 12: "all 4 frozen phrases
 * remain unreachable — formatNarration always passes eventKind: null, since detecting
 * all_clear/empty_result/no_signal/critic_tell needs per-role business logic".
 *
 * Each predicate is conservative by design: a frozen phrase firing slightly too rarely
 * is the acceptable failure direction; firing wrongly is not. Every predicate returns
 * null when uncertain, encoded as the actual default branch.
 *
 * See docs/superpowers/specs/2026-08-05-comms-deck-stage14-design.md section C
 * for the specification table.
 */

import type { EventKind, Severity } from './voicePacks';
import type { VoiceRole } from './agentVoiceRoles';
import { resolveVoiceRole } from './agentVoiceRoles';

/**
 * Input data for frozen-phrase predicates.
 *
 * Different predicates may ignore fields that don't apply to them. For example,
 * all_clear is global state and ignores dispatch-specific fields.
 */
export interface FrozenPhraseInput {
  // For dispatch-specific predicates (empty_result, no_signal, critic_tell)
  // All require: completed === true. Per spec, these fire only on completed dispatches.
  dispatch?: {
    subagentType: string; // Used to resolve VoiceRole
    severity: Severity;
    completed: boolean; // REQUIRED: empty_result/no_signal/critic_tell fire only on completed dispatches
    toolUses?: Array<{ name: string }>;
    toolResults?: Array<{ resultLength: number }>;
    exitState?: 'ok' | 'partial' | 'error' | 'fatal' | 'timeout' | 'blocked' | null;
  };

  // For all_clear predicate (global state) — not affected by completion status
  state?: {
    openDispatchCount: number;
    anomalyCount: number;
    hasPendingPermissionRequest: boolean;
  };
}

/**
 * Detect the event kind for a frozen phrase, or null if uncertain.
 *
 * Returns the detected EventKind that can be passed to renderNarration() to
 * prepend a frozen phrase, or null if the input does not match any predicate.
 */
export function detectEventKind(input: FrozenPhraseInput): EventKind | null {
  // Try dispatch-specific predicates if dispatch data is available and completed
  if (input.dispatch && input.dispatch.completed) {
    const role = resolveVoiceRole(input.dispatch.subagentType);

    // CINDER: completed review dispatch at severity >= 3
    const criticTell = detectCriticTell(role, input.dispatch.severity);
    if (criticTell) return 'critic_tell';

    // PILGRIM: completed dispatch whose tool calls were all reads/searches
    // and whose result lengths were all trivially small
    const emptyResult = detectEmptyResult(role, input.dispatch.toolUses, input.dispatch.toolResults);
    if (emptyResult) return 'empty_result';

    // ASSAY: completed dispatch with fatal exit state, or zero tool calls
    // where tool calls were expected
    const noSignal = detectNoSignal(role, input.dispatch.exitState, input.dispatch.toolUses);
    if (noSignal) return 'no_signal';
  }

  // STEWARD: global state check (zero open dispatches, zero anomalies, zero pending permission requests)
  // Not tied to any single dispatch's completion status — checks fleet state
  if (input.state) {
    const allClear = detectAllClear(input.state);
    if (allClear) return 'all_clear';
  }

  return null;
}

/**
 * STEWARD: "Nothing requires you."
 *
 * Returns true when zero open dispatches, zero anomalies, and zero pending
 * permission requests. This is conservative: it requires all three conditions
 * to be met simultaneously.
 *
 * Cannot detect: whether the operator is actually looking at the interface
 * (presence). This fires based on work state only, not attention state.
 */
function detectAllClear(state: {
  openDispatchCount: number;
  anomalyCount: number;
  hasPendingPermissionRequest: boolean;
}): boolean {
  return state.openDispatchCount === 0 && state.anomalyCount === 0 && !state.hasPendingPermissionRequest;
}

/**
 * PILGRIM: "The path exists. It's empty."
 *
 * Returns true when a completed dispatch's tool calls were all read/search
 * shaped (e.g., Read, Glob, Grep, WebFetch) and all result lengths were
 * trivially small (<=50 bytes, representing "nothing found").
 *
 * Cannot detect: whether tool results actually found nothing vs. returned
 * a short error message. Result content is not available, only length.
 * Also cannot detect: read-shaped tools used in unusual ways
 * (e.g., a Bash command that looks like it's reading but is actually doing work).
 */
function detectEmptyResult(
  role: VoiceRole,
  toolUses?: Array<{ name: string }>,
  toolResults?: Array<{ resultLength: number }>
): boolean {
  if (role !== 'PILGRIM') return false;
  if (!toolUses || !toolResults) return false;

  // No tool calls means no result to check -- not empty_result
  if (toolUses.length === 0) return false;

  // All tool calls must be read/search shaped
  const readLikeTools = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);
  const allReadLike = toolUses.every((tool) => readLikeTools.has(tool.name));
  if (!allReadLike) return false;

  // All result lengths must be trivially small (<=50 bytes)
  const allSmall = toolResults.every((result) => result.resultLength <= 50);
  if (!allSmall) return false;

  return true;
}

/**
 * ASSAY: "Treat everything unverified."
 *
 * Returns true when a completed dispatch has exit_state 'fatal', or when
 * zero tool calls were made where tool calls were expected. This signals
 * that no signal (output/data) is available for verification.
 *
 * Cannot detect: whether tool calls were actually needed (heuristic based on
 * tool call count). A dispatch that correctly made no tool calls because none
 * were needed will match this predicate.
 * Also cannot detect: fatal errors that left partial output (exit_state is
 * 'partial' or 'error' rather than 'fatal').
 */
function detectNoSignal(
  role: VoiceRole,
  exitState?: string | null,
  toolUses?: Array<{ name: string }>
): boolean {
  if (role !== 'ASSAY') return false;

  // Fatal exit state: no signal available
  if (exitState === 'fatal') return true;

  // Zero tool calls where tool calls were expected: also no signal
  // Heuristic: if a dispatch ran but made no tool calls, assume tool calls were expected.
  // This is conservative; only fire if exit state explicitly indicates failure (not ok, not null/undefined).
  if ((!toolUses || toolUses.length === 0) && exitState !== 'ok' && exitState !== null && exitState !== undefined) {
    // Only fire if exit state indicates the dispatch ran but had issues
    return true;
  }

  return false;
}

/**
 * CINDER: "Oh. That's actually interesting."
 *
 * Returns true when a completed review dispatch (code-reviewer, CINDER-mapped
 * role) has severity >= 3. This is a high-severity finding worthy of attention.
 *
 * Cannot detect: whether findings are actually correct or justified. Severity
 * is a measure of confidence/weight, not of actual defect presence.
 * Also cannot detect: review dispatches that should have been high-severity
 * but were computed lower (different agents may calibrate differently).
 */
function detectCriticTell(role: VoiceRole, severity: Severity): boolean {
  if (role !== 'CINDER') return false;

  return severity >= 3;
}
