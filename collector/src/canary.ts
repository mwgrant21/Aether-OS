import type { DatabaseSync } from 'node:sqlite';

export const REQUIRED_FIELDS_BY_EVENT: Record<string, string[]> = {
  PreToolUse: ['tool_name'],
  PostToolUse: ['tool_name'],
  Notification: ['notification_type'],
  Stop: [],
};

function logDrift(db: DatabaseSync, nowMs: number, detail: string): void {
  console.error(`[aether-collector] contract drift detected: ${detail}`);
  db.prepare('INSERT INTO drift_log (detected_at_ms, detail) VALUES (?, ?)').run(nowMs, detail);
}

/**
 * Checks a raw (unparsed) hook payload against the fields this collector
 * depends on for its KNOWN event types, logging loudly (console.error + a
 * drift_log row) when a known event is missing a field it should have --
 * signals Claude Code's hook payload shape drifted since this was written.
 * Never throws and never blocks ingest; a wholly unrecognized event name is
 * parseHookPayload's concern (silently skipped there), not drift here.
 */
export function checkForDrift(raw: unknown, db: DatabaseSync, nowMs: number): void {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
    const obj = raw as Record<string, unknown>;
    const eventName = typeof obj.hook_event_name === 'string' ? obj.hook_event_name : null;
    if (eventName === null || !(eventName in REQUIRED_FIELDS_BY_EVENT)) return;

    const required = REQUIRED_FIELDS_BY_EVENT[eventName];
    const missing = required.filter((field) => obj[field] === undefined || obj[field] === null);
    if (missing.length > 0) {
      logDrift(db, nowMs, `${eventName} payload missing expected field(s): ${missing.join(', ')}`);
    }
  } catch {
    // Never let a canary bug break ingest.
  }
}
