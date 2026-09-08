import type { DatabaseSync } from 'node:sqlite';
import { parseHookPayload, type ParsedHookEvent } from './hookPayload.js';
import { checkForDrift, REQUIRED_FIELDS_BY_EVENT } from './canary.js';

/**
 * Decodes one raw spool line into an insertable event, or null when the line
 * must be skipped for good: blank, malformed JSON, an unrecognized shape, or
 * a known event missing a field this collector depends on. Runs the drift
 * canary against whatever parsed, regardless of outcome. Never throws.
 *
 * A null here is a PERMANENT verdict on the line -- retrying can never make
 * it ingest -- which is what lets the spool tailer tell "drop this line"
 * apart from "the database refused a write" (see insertHookEvent). Before
 * the two were separated, both collapsed into one `false`, and the tailer
 * deleted spool files whose every insert had failed on SQLITE_BUSY.
 */
export function decodeLine(db: DatabaseSync, rawLine: string, receivedAtMs: number): ParsedHookEvent | null {
  let parsed: unknown;
  try {
    if (rawLine.trim().length === 0) return null;
    parsed = JSON.parse(rawLine);
  } catch {
    return null;
  }

  try {
    checkForDrift(parsed, db, receivedAtMs);
  } catch {
    // checkForDrift already guards itself; this is a final backstop.
  }

  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const eventName = typeof obj.hook_event_name === 'string' ? obj.hook_event_name : null;
    if (eventName !== null && eventName in REQUIRED_FIELDS_BY_EVENT) {
      const required = REQUIRED_FIELDS_BY_EVENT[eventName];
      const missing = required.some((field: string) => obj[field] === undefined || obj[field] === null);
      if (missing) return null;
    }
  }

  return parseHookPayload(parsed, receivedAtMs);
}

/**
 * Inserts one decoded event. THROWS on database failure (SQLITE_BUSY, disk
 * full, schema drift) instead of swallowing it: a refused write is a reason
 * to keep the event and retry, never to discard it, and the caller owns the
 * roll-back-and-retry decision. The spool tailer runs a whole file's inserts
 * inside one transaction so a retry after a failure never duplicates rows.
 */
export function insertHookEvent(db: DatabaseSync, event: ParsedHookEvent): void {
  db.prepare(
    `INSERT INTO events (hook_event_name, session_id, project_rel_path, tool_name, had_tool_input, had_tool_response, notification_type, occurred_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.hookEventName,
    event.sessionId,
    event.cwd,
    event.toolName,
    event.hadToolInput ? 1 : 0,
    event.hadToolResponse ? 1 : 0,
    event.notificationType,
    event.occurredAtMs
  );
}

/**
 * decodeLine + insertHookEvent with the write failure folded into `false`.
 * Kept for single-line callers and tests; the spool tailer deliberately uses
 * the two halves directly so that a write failure keeps the file instead of
 * being indistinguishable from a corrupt line.
 */
export function ingestLine(db: DatabaseSync, rawLine: string, receivedAtMs: number): boolean {
  const event = decodeLine(db, rawLine, receivedAtMs);
  if (event === null) return false;
  try {
    insertHookEvent(db, event);
    return true;
  } catch {
    return false;
  }
}
