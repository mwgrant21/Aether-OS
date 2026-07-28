import type { DatabaseSync } from 'node:sqlite';

export const RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function dayKeyUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Rolls up and deletes raw `events` rows older than RETENTION_WINDOW_MS,
 * grouped by UTC day/hook_event_name/tool_name. Aggregate counts survive in
 * `daily_rollups`; the underlying rows do not (privacy-and-data.md SS6).
 * Idempotent: re-running finds nothing left to delete for an already-rolled-up
 * day and leaves its rollup row's count unchanged.
 */
export function compact(db: DatabaseSync, nowMs: number): { rolledUpDays: number; deletedRows: number } {
  const cutoffMs = nowMs - RETENTION_WINDOW_MS;

  const staleRows = db
    .prepare('SELECT id, hook_event_name, tool_name, occurred_at_ms FROM events WHERE occurred_at_ms < ?')
    .all(cutoffMs) as { id: number; hook_event_name: string; tool_name: string | null; occurred_at_ms: number }[];

  if (staleRows.length === 0) {
    return { rolledUpDays: 0, deletedRows: 0 };
  }

  // tool_name is normalized to '' (never null) before it reaches daily_rollups:
  // SQLite treats NULL as distinct from every other NULL in a PRIMARY KEY/unique
  // index, so ON CONFLICT(day, hook_event_name, tool_name) never fires for rows
  // with a null tool_name (Stop/Notification events), causing silent duplicate
  // rollup rows. '' is used as the sentinel since it can never collide with a
  // real tool name. The raw `events` table is unaffected -- only this aggregate.
  const groups = new Map<string, { day: string; hookEventName: string; toolName: string; count: number }>();
  for (const row of staleRows) {
    const day = dayKeyUtc(row.occurred_at_ms);
    const toolName = row.tool_name ?? '';
    const key = `${day}|${row.hook_event_name}|${toolName}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(key, { day, hookEventName: row.hook_event_name, toolName, count: 1 });
    }
  }

  const upsert = db.prepare(
    `INSERT INTO daily_rollups (day, hook_event_name, tool_name, event_count) VALUES (?, ?, ?, ?)
     ON CONFLICT(day, hook_event_name, tool_name) DO UPDATE SET event_count = event_count + excluded.event_count`
  );
  for (const g of groups.values()) {
    upsert.run(g.day, g.hookEventName, g.toolName, g.count);
  }

  const deleteStale = db.prepare('DELETE FROM events WHERE occurred_at_ms < ?');
  deleteStale.run(cutoffMs);

  const distinctDays = new Set(Array.from(groups.values()).map((g) => g.day));
  return { rolledUpDays: distinctDays.size, deletedRows: staleRows.length };
}
