import type { DatabaseSync } from 'node:sqlite';
import { parseHookPayload } from './hookPayload';
import { checkForDrift, REQUIRED_FIELDS_BY_EVENT } from './canary';

/**
 * Ingests one raw spool line: parses JSON, runs the drift canary against
 * whatever parsed regardless of outcome, then parses into the derived shape
 * and inserts one events row. Never throws -- any failure at any stage simply
 * skips the line (returns false), since a single corrupt line must never stop
 * the tailer from processing the rest of the spool.
 */
export function ingestLine(db: DatabaseSync, rawLine: string, receivedAtMs: number): boolean {
  let parsed: unknown;
  try {
    if (rawLine.trim().length === 0) return false;
    parsed = JSON.parse(rawLine);
  } catch {
    return false;
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
      const missing = required.some((field) => obj[field] === undefined || obj[field] === null);
      if (missing) return false;
    }
  }

  const event = parseHookPayload(parsed, receivedAtMs);
  if (event === null) return false;

  try {
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
    return true;
  } catch {
    return false;
  }
}
