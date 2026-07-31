import type { DatabaseSync } from 'node:sqlite';
import type { ToolCallHistory } from './toolCallHistory.js';
import { computeSeverity } from './personalitySpine.js';

// Grace period before a dispatch's session liveness is even checked: an entry
// that opened moments ago may simply predate the first fleet poll ever seeing
// its session, so checking session liveness before this age would false-flag
// it as fatal. Matches the ~15s fleet-poll interval (see fleetPoll.ts).
const SESSION_CHECK_MIN_AGE_MS = 15000;

// A session's fleet_sessions row is considered gone once its last_seen_ms is
// this old -- matches fleetPoll.ts's own STALE_MS (twice the poll interval).
const SESSION_STALE_MS = 30000;

// Fixed timeout: an Agent dispatch open this long is fatal regardless of
// whether its session is still reporting as alive.
const FATAL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Detects 'Agent'-named open dispatches that never received a completion
 * event (see usageIngest.ts#ingestDispatchEvent) and writes them into
 * `dispatches` as exit_state='fatal' rows, via the same
 * INSERT ... ON CONFLICT(tool_use_id) DO UPDATE upsert Task 4 established --
 * so re-sweeping the same stale entry on a later tick is idempotent (updates
 * duration_ms/ended_at_ms to the newer nowMs rather than duplicating a row).
 *
 * Two independent fatal conditions, either one triggers:
 *   (a) the dispatch's session has no fleet_sessions row at all, OR that row's
 *       last_seen_ms is older than SESSION_STALE_MS -- but only checked once
 *       the open entry itself is at least SESSION_CHECK_MIN_AGE_MS old.
 *   (b) the open entry has been open past FATAL_TIMEOUT_MS, regardless of
 *       session liveness.
 *
 * Only 'Agent'-named open entries are ever swept; any other tool call is left
 * untouched regardless of age.
 */
export function sweepStaleDispatches(
  db: DatabaseSync,
  history: ToolCallHistory,
  nowMs: number
): { staleFound: number } {
  const sessionLookup = db.prepare('SELECT last_seen_ms FROM fleet_sessions WHERE session_id = ?');
  // updateHistory only closes an open entry via a normal tool_result; an
  // Agent dispatch's real completion arrives as a 'user'-kind task-notification
  // instead (see ingestDispatchEvent), so a completed Agent entry lingers in
  // history.openByToolUseId forever. Without this guard, a dispatch that
  // completed genuinely ('ok') would be re-swept and overwritten as 'fatal'
  // the moment it aged past the grace period / session went stale.
  const existingExitState = db.prepare('SELECT exit_state FROM dispatches WHERE tool_use_id = ?');
  const upsert = db.prepare(
    `INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms,
       agent_id, task_kind, session_id, retries, exit_state, severity, median_ms_at_eval)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tool_use_id) DO UPDATE SET tokens = excluded.tokens, tool_uses = excluded.tool_uses,
       duration_ms = excluded.duration_ms, ended_at_ms = excluded.ended_at_ms,
       agent_id = excluded.agent_id, task_kind = excluded.task_kind, session_id = excluded.session_id,
       retries = excluded.retries, exit_state = excluded.exit_state, severity = excluded.severity,
       median_ms_at_eval = excluded.median_ms_at_eval`
  );

  let staleFound = 0;

  for (const [toolUseId, open] of Object.entries(history.openByToolUseId)) {
    if (open.toolName !== 'Agent') continue;

    const existing = existingExitState.get(toolUseId) as { exit_state: string } | undefined;
    if (existing && existing.exit_state !== 'fatal') continue;

    const ageMs = nowMs - open.startedAt;
    const timedOut = ageMs >= FATAL_TIMEOUT_MS;

    let sessionGone = false;
    if (ageMs >= SESSION_CHECK_MIN_AGE_MS) {
      const row = sessionLookup.get(open.sessionId) as { last_seen_ms: number } | undefined;
      sessionGone = !row || nowMs - row.last_seen_ms > SESSION_STALE_MS;
    }

    if (!timedOut && !sessionGone) continue;

    const durationMs = ageMs;
    const severity = computeSeverity({
      exit: 'fatal',
      retries: 0,
      elapsedMs: durationMs,
      medianMsAtEval: null,
    });

    upsert.run(
      toolUseId, 0, 0, durationMs, open.startedAt, nowMs,
      open.subagentType, open.subagentType, open.sessionId, 0, 'fatal', severity, null
    );
    staleFound += 1;
  }

  return { staleFound };
}
