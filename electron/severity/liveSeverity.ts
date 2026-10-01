// electron/severity/liveSeverity.ts
// Live severity for the pinned session's dispatches (spec
// 2026-09-30-real-severity-design.md sections 4 and 5). Completion: real
// outcome -> computeSeverity with the baseline snapshot taken BEFORE this run
// is recorded. Stall: no progress past STALL_MS or the pinned pty exited ->
// fatal/4 exactly once. A later `completed` outcome replaces the stall and
// emits one "Recovered." line; a later failed/killed/unknown outcome is
// narrated from that outcome alone, with no prefix.
// Call order per tick: onCompleted for every completion, THEN checkStalls.
//
// Live path only: NOT in scripts/sync-severity-core.mjs CORE_FILES.
import type { CompletedDispatchUsage, RealAgentDispatch, TrackedOutcome } from '../../src/state/liveAgentsMath';
import { computeSeverity, exitStateForStatus, type Severity } from './computeSeverity';
import { isStalled, lastProgressMs as resolveLastProgressMs } from './isStalled';
import type { DurationBaselineStore } from './durationBaseline';

export const STALL_CHECK_INTERVAL_MS = 30_000;
export const RECOVERED_PREFIX = 'Recovered. ';

export interface LiveNarrationPayload {
  toolUseId: string;
  narration: string;
  severity: Severity;
  // Agent type name (not content): lets the renderer voice the Comms line
  // without waiting for the snapshot that would otherwise carry it.
  subagentType: string;
  // true: the dispatch really ended (renderer adds a Comms completion).
  // false: a stall line for a still-open dispatch (roster only).
  final: boolean;
}

export interface LiveSeverityDeps {
  baseline: Pick<DurationBaselineStore, 'medianFor' | 'record'>;
  narrate: (subagentType: string, severity: Severity) => string | null;
}

export interface LiveSeverityNarrator {
  /** toolErrors: count from the dispatch's subagent file; null = unknown. Only a completed outcome uses it. */
  onCompleted(completed: CompletedDispatchUsage, tracked: TrackedOutcome | undefined, toolErrors?: number | null): LiveNarrationPayload | null;
  /** lastWriteFor: the dispatch's subagent-file mtime, or null (no link); dispatch start is the fallback. */
  checkStalls(open: readonly RealAgentDispatch[], nowMs: number, sessionEnded: boolean, lastWriteFor?: (toolUseId: string) => number | null): LiveNarrationPayload[];
}

export function createLiveSeverityNarrator(deps: LiveSeverityDeps): LiveSeverityNarrator {
  const stalled = new Set<string>();
  const firstSeenMs = new Map<string, number>();

  return {
    onCompleted(c, tracked, toolErrors = null) {
      const outcome = tracked?.outcome ?? { status: 'unknown' as const };
      const medianMsAtEval = deps.baseline.medianFor(c.subagentType);
      const result = computeSeverity({
        exit: exitStateForStatus(outcome.status),
        // No usage block means no measured duration: NaN, which
        // computeSeverity's isFinite guard treats as "no slowness bump".
        // Only completed runs are scored for slowness: unknown stays at 1.
        elapsedMs: outcome.status === 'completed' && outcome.usage ? outcome.usage.durationMs : Number.NaN,
        medianMsAtEval,
        toolErrors: outcome.status === 'completed' ? toolErrors : null,
      });
      deps.baseline.record(c.subagentType, outcome);
      firstSeenMs.delete(c.toolUseId);
      const wasStalled = stalled.delete(c.toolUseId);
      const text = deps.narrate(c.subagentType, result.severity);
      if (wasStalled && outcome.status === 'completed') {
        return { toolUseId: c.toolUseId, narration: text ? `${RECOVERED_PREFIX}${text}` : RECOVERED_PREFIX.trim(), severity: result.severity, subagentType: c.subagentType, final: true };
      }
      if (text) return { toolUseId: c.toolUseId, narration: text, severity: result.severity, subagentType: c.subagentType, final: true };
      // A stalled dispatch that ended with nothing to say: an empty narration
      // clears the stall line from the roster (and adds no Comms line).
      return wasStalled ? { toolUseId: c.toolUseId, narration: '', severity: result.severity, subagentType: c.subagentType, final: true } : null;
    },

    checkStalls(open, nowMs, sessionEnded, lastWriteFor) {
      const openIds = new Set(open.map((d) => d.toolUseId));
      for (const id of [...firstSeenMs.keys()]) if (!openIds.has(id)) firstSeenMs.delete(id);
      for (const id of [...stalled]) if (!openIds.has(id)) stalled.delete(id);

      const out: LiveNarrationPayload[] = [];
      for (const d of open) {
        if (!firstSeenMs.has(d.toolUseId)) firstSeenMs.set(d.toolUseId, nowMs);
        if (stalled.has(d.toolUseId)) continue;
        // Spec section 5 / F15: progress is the last write to the dispatch's
        // own subagent file (future-mtime rule shared with the collector via
        // isStalled.ts), with dispatch start as the fallback when there is no
        // link or file. The open list only ever holds top-level dispatches
        // (the tracker tails the pinned parent transcript); nested ones close
        // by tool_result and are never swept here, as in the collector.
        // liveAgentsMath turns a missing timestamp into the 1970 epoch; that
        // is "unknown", so measure from when this narrator first saw it.
        const startedMs = Date.parse(d.startedAt);
        const baseMs = Number.isFinite(startedMs) && startedMs > 0 ? startedMs : firstSeenMs.get(d.toolUseId) ?? nowMs;
        const lastProgressMs = resolveLastProgressMs(baseMs, lastWriteFor?.(d.toolUseId), nowMs);
        if (!isStalled({ lastProgressMs, sessionEnded }, nowMs)) continue;
        stalled.add(d.toolUseId);
        const result = computeSeverity({ exit: 'fatal', elapsedMs: nowMs - baseMs, medianMsAtEval: deps.baseline.medianFor(d.subagentType) });
        const text = deps.narrate(d.subagentType, result.severity);
        if (text) out.push({ toolUseId: d.toolUseId, narration: text, severity: result.severity, subagentType: d.subagentType, final: false });
      }
      return out;
    },
  };
}

// One [diag] line per previously unseen unrecognised status value (spec
// section 3). A Set, not a plain object: '__proto__' and 'constructor' pass
// the tag's [a-z_] shape, and as object keys they would read as already seen
// or write to the prototype.
export function createUnseenStatusReporter(write: (line: string) => void): (tag: string | null) => void {
  const seen = new Set<string>();
  return (tag) => {
    if (tag === null || seen.has(tag)) return;
    seen.add(tag);
    write(`[diag] dispatch status not recognised tag=${tag}; narrated as ok at=${new Date().toISOString()}`);
  };
}
