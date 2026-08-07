// narrationFeed.ts (Stage 14, Task 5)
//
// Wires real app events into Stage 12's voice-pack narration system and
// gives interruptionBudget.ts (instrumented since Stage 12, unconsumed since)
// its first real consumer. Produces NarrationMessage records the reducer
// appends to a channel's message list -- see reducer.ts's SET_DISPATCH_NARRATION,
// SET_ANOMALIES, SET_PENDING_PERMISSION_REQUEST, and SET_PENDING_POST_TOOL_FLAG
// cases for where these events originate.
//
// Distinct from the model-written `dispatchNarrations` (electron/narrationGenerator.ts,
// rendered on AgentRosterCard): that path always calls renderNarration(pack, severity, null)
// -- eventKind is always null there, so the four frozen phrases are unreachable through it.
// This feed is the actual consumer of Task 4's detectEventKind, passing the real eventKind
// through to renderNarration -- that is the point of this task.
import type { Severity, EventKind } from '../../shared/voicePacks';
import { VOICE_PACKS } from '../../shared/voicePacks';
import type { VoiceRole } from '../../shared/agentVoiceRoles';
import { resolveVoiceRole } from '../../shared/agentVoiceRoles';
import { renderNarration } from '../../shared/voiceRender';
import { detectEventKind } from '../../shared/frozenPhraseDetect';
import { applyNarrationVerbosity, NARRATION_FLOOR_SEVERITY } from '../../shared/narrationVerbosity';
import { canVolunteer, spendBudget, createInterruptionBudget, type InterruptionBudgetState } from '../../shared/interruptionBudget';
import type { AetherState, NarrationMessage } from '../../state/types';
import type { Anomaly } from '../../shared/anomalyDetectors';
import { AETHER_CHANNEL_ID } from './commsChannels';

export interface DispatchCompletedEvent {
  kind: 'dispatchCompleted';
  toolUseId: string;
  subagentType: string;
  severity: Severity;
  // Optional richer shape for the frozen-phrase predicates that need it
  // (empty_result, no_signal). Not available from any real event source
  // wired up in this stage -- see task-5-report.md's Known Limitations --
  // so production callers omit these and detectEventKind's own
  // "return null when uncertain" default handles it. critic_tell (CINDER)
  // needs only role + severity, so it fires for real without these.
  toolUses?: Array<{ name: string }>;
  toolResults?: Array<{ resultLength: number }>;
  exitState?: 'ok' | 'partial' | 'error' | 'fatal' | 'timeout' | 'blocked' | null;
}

export interface AnomalyDetectedEvent {
  kind: 'anomalyDetected';
  toolUseId: string;
  anomalyKind: Anomaly['kind'];
}

export interface PermissionPendingEvent {
  kind: 'permissionPending';
}

export interface PostToolFlagEvent {
  kind: 'postToolFlag';
  anomalyKind: Anomaly['kind'];
}

// Fired whenever fleet-level state changes (an anomaly clears, a permission
// request resolves) so STEWARD can check the all_clear condition (spec §8's
// AETHER/STEWARD binding). Only ever produces a message when the state is
// actually all-clear -- see narrationForEvent below.
export interface StewardStateCheckEvent {
  kind: 'stewardStateCheck';
}

export type NarrationEvent =
  | DispatchCompletedEvent
  | AnomalyDetectedEvent
  | PermissionPendingEvent
  | PostToolFlagEvent
  | StewardStateCheckEvent;

// Heuristic severity per anomaly kind (there is no upstream severity for
// anomalies the way completed dispatches carry one from narrationGenerator.ts).
// stalledPermission blocks progress outright (4); writeDeleteRewrite is a real
// churn pattern worth a look (3); reReadLoop/zeroEditBurn are milder waste
// signals (2). Documented here since it is a judgment call, not a spec value.
const ANOMALY_SEVERITY: Record<Anomaly['kind'], Severity> = {
  stalledPermission: 4,
  writeDeleteRewrite: 3,
  reReadLoop: 2,
  zeroEditBurn: 2,
};

function toSeverity(n: number): Severity {
  return Math.max(0, Math.min(4, Math.round(n))) as Severity;
}

interface ResolvedNarration {
  role: VoiceRole;
  channelId: string;
  severity: Severity;
  eventKind: EventKind | null;
}

function resolve(event: NarrationEvent, state: AetherState): ResolvedNarration | null {
  switch (event.kind) {
    case 'dispatchCompleted': {
      const role = resolveVoiceRole(event.subagentType);
      const severity = toSeverity(event.severity);
      const eventKind = detectEventKind({
        dispatch: {
          subagentType: event.subagentType,
          severity,
          completed: true,
          toolUses: event.toolUses,
          toolResults: event.toolResults,
          exitState: event.exitState,
        },
      });
      return { role, channelId: `dispatch:${event.toolUseId}`, severity, eventKind };
    }

    case 'anomalyDetected': {
      return { role: 'STEWARD', channelId: AETHER_CHANNEL_ID, severity: ANOMALY_SEVERITY[event.anomalyKind], eventKind: 'anomaly' };
    }

    case 'postToolFlag': {
      return { role: 'STEWARD', channelId: AETHER_CHANNEL_ID, severity: 4, eventKind: 'blocked' };
    }

    case 'permissionPending': {
      return { role: 'STEWARD', channelId: AETHER_CHANNEL_ID, severity: 3, eventKind: 'blocked' };
    }

    case 'stewardStateCheck': {
      const eventKind = detectEventKind({
        state: {
          openDispatchCount: state.realAgents.length,
          anomalyCount: state.anomalies.length,
          hasPendingPermissionRequest: state.pendingPermissionRequest !== null,
        },
      });
      // Only produce a line when the state actually resolved to all_clear --
      // this event exists purely to reach that one frozen phrase; there is no
      // "still not clear" line STEWARD is supposed to volunteer here.
      if (eventKind !== 'all_clear') return null;
      return { role: 'STEWARD', channelId: AETHER_CHANNEL_ID, severity: 1, eventKind };
    }

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/**
 * Maps a real app event to a rendered NarrationMessage, or null if nothing
 * should be said (no sample at that severity, verbosity dial suppressed it,
 * or the event doesn't resolve to a narratable condition).
 *
 * `interrupts` on the returned message is always false here -- narrationForEvent
 * is a pure function of (event, state) and has no budget to spend. Callers
 * (the reducer) run the result through rankForInterruption, which does hold
 * and mutate the per-channel InterruptionBudgetState.
 */
export function narrationForEvent(event: NarrationEvent, state: AetherState): NarrationMessage | null {
  const resolved = resolve(event, state);
  if (!resolved) return null;

  const pack = VOICE_PACKS[resolved.role];
  const rendered = renderNarration(pack, resolved.severity, resolved.eventKind);
  const text = applyNarrationVerbosity(rendered, state.cfg.narrationVerbosity, resolved.severity);
  if (!text) return null;

  return {
    id: `narr-${resolved.channelId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channelId: resolved.channelId,
    role: resolved.role,
    voiceName: pack.display_name,
    text,
    severity: resolved.severity,
    atMs: Date.now(),
    interrupts: false,
  };
}

// Phase 1 placeholder window (spec §8 notes the real window value N is
// Phase 3, "unknowable without observed traffic"). 60s keeps a channel from
// raising its unread badge more than once a minute for sub-floor severity.
export const INTERRUPTION_WINDOW_MS = 60_000;

/**
 * interruptionBudget.ts's first real consumer. Ranks a single narration
 * message against its channel's budget: severity >= 3 always interrupts
 * (mirrors applyNarrationVerbosity's own floor -- a high-severity line
 * should raise the badge the same way it always renders regardless of the
 * dial), otherwise the channel's existing canVolunteer/spendBudget window
 * governs. Returns the updated budget map so the reducer can persist it.
 */
export function rankForInterruption(
  message: NarrationMessage,
  budgets: Record<string, InterruptionBudgetState>,
  nowMs: number,
  windowMs: number = INTERRUPTION_WINDOW_MS
): { interrupts: boolean; budgets: Record<string, InterruptionBudgetState> } {
  const current = budgets[message.channelId] ?? createInterruptionBudget();

  if (message.severity >= NARRATION_FLOOR_SEVERITY || canVolunteer(current, nowMs, windowMs)) {
    return { interrupts: true, budgets: { ...budgets, [message.channelId]: spendBudget(current, nowMs) } };
  }

  return { interrupts: false, budgets };
}

/** Appends a message to a channel's narration list, capped at 100 entries, oldest evicted first. */
export function appendNarrationMessage(
  messages: Record<string, NarrationMessage[]>,
  message: NarrationMessage
): Record<string, NarrationMessage[]> {
  const existing = messages[message.channelId] ?? [];
  return { ...messages, [message.channelId]: [...existing, message].slice(-100) };
}
