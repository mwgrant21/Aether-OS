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

  let rolledUpDays = 0;

  if (staleRows.length > 0) {
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
    rolledUpDays = distinctDays.size;
  }

  // drift_log has no rollup/aggregate step -- it's diagnostic noise, not a
  // metric worth preserving in aggregate, unlike `events`. Deleted
  // unconditionally (NOT nested inside the `staleRows.length > 0` branch
  // above): a sustained fleet-poll failure (Task 5's pollFleet) writes one
  // drift_log row per failed 15s poll cycle, so a cycle can have zero stale
  // `events` rows and still have plenty of stale drift_log rows to clear.
  db.prepare('DELETE FROM drift_log WHERE detected_at_ms < ?').run(cutoffMs);

  const staleAnomalies = db
    .prepare('SELECT id, kind, detected_at_ms FROM anomalies WHERE detected_at_ms < ?')
    .all(cutoffMs) as { id: number; kind: string; detected_at_ms: number }[];

  if (staleAnomalies.length > 0) {
    const anomalyGroups = new Map<string, number>();
    for (const row of staleAnomalies) {
      const key = `${dayKeyUtc(row.detected_at_ms)}|${row.kind}`;
      anomalyGroups.set(key, (anomalyGroups.get(key) ?? 0) + 1);
    }
    const upsertAnomalyRollup = db.prepare(
      `INSERT INTO daily_anomaly_rollups (day, kind, anomaly_count) VALUES (?, ?, ?)
       ON CONFLICT(day, kind) DO UPDATE SET anomaly_count = anomaly_count + excluded.anomaly_count`
    );
    for (const [key, count] of anomalyGroups.entries()) {
      const [day, kind] = key.split('|');
      upsertAnomalyRollup.run(day, kind, count);
    }
    db.prepare('DELETE FROM anomalies WHERE detected_at_ms < ?').run(cutoffMs);
  }

  // tool_calls/dispatches: unconditional deletion, no rollup -- see this
  // task's own header note for why (recent-activity view, not an audit log).
  db.prepare('DELETE FROM tool_calls WHERE closed_at_ms < ?').run(cutoffMs);
  db.prepare('DELETE FROM dispatches WHERE ended_at_ms < ?').run(cutoffMs);

  return { rolledUpDays, deletedRows: staleRows.length };
}
