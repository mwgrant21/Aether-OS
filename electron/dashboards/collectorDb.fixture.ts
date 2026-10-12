import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Test-only. Columns copied from collector/src/schema.ts (never imported:
// the app and the collector do not share runtime code).
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

export const DAY_MS = 86_400_000;

export function createFixtureCollectorDb(nowMs: number): string {
  const path = join(mkdtempSync(join(tmpdir(), 'aether-boards-')), 'collector.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at_ms INTEGER NOT NULL, model TEXT,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_creation_input_tokens INTEGER NOT NULL, cache_read_input_tokens INTEGER NOT NULL, source_file_rel TEXT);
    CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      file_path_rel TEXT, started_at_ms INTEGER NOT NULL, closed_at_ms INTEGER NOT NULL, source_file_rel TEXT);
    CREATE TABLE dispatches (tool_use_id TEXT PRIMARY KEY, tokens INTEGER, tool_uses INTEGER, duration_ms INTEGER,
      started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER NOT NULL, agent_id TEXT, task_kind TEXT, session_id TEXT,
      retries INTEGER NOT NULL DEFAULT 0, exit_state TEXT NOT NULL DEFAULT 'ok', severity INTEGER,
      median_ms_at_eval INTEGER, dispatch_status TEXT);
    CREATE TABLE anomalies (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, tool_use_id TEXT NOT NULL,
      detail TEXT NOT NULL, detected_at_ms INTEGER NOT NULL);
    CREATE TABLE daily_anomaly_rollups (day TEXT NOT NULL, kind TEXT NOT NULL, anomaly_count INTEGER NOT NULL,
      PRIMARY KEY (day, kind));
    CREATE TABLE transcript_files (file_path TEXT PRIMARY KEY, last_offset INTEGER NOT NULL, last_scanned_ms INTEGER NOT NULL);
  `);
  const usage = db.prepare('INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) VALUES (?, ?, ?, ?, ?, ?)');
  usage.run(nowMs - 3_600_000, 'test-opus', 1000, 500, 200, 3000);
  usage.run(nowMs - 3_600_000, null, 10, 10, 0, 0);
  usage.run(nowMs - 2 * DAY_MS, 'test-sonnet', 2000, 100, 0, 1000);
  const tool = db.prepare('INSERT INTO tool_calls (tool_use_id, tool_name, started_at_ms, closed_at_ms) VALUES (?, ?, ?, ?)');
  ['Read', 'Read', 'Read', 'Bash'].forEach((name, i) => tool.run(`tu${i}`, name, nowMs - 3_600_000, nowMs - 3_590_000));
  const dispatch = db.prepare('INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms, agent_id, task_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  dispatch.run('d1', 50_000, 12, 90_000, nowMs - 7_200_000, nowMs - 7_110_000, 'Explore', 'Explore');
  dispatch.run('d2', null, null, 30_000, nowMs - DAY_MS, nowMs - DAY_MS + 30_000, null, null);
  const d = new Date(nowMs);
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  db.prepare('INSERT INTO daily_anomaly_rollups (day, kind, anomaly_count) VALUES (?, ?, ?)').run(today, 'loop', 2);
  const anomaly = db.prepare('INSERT INTO anomalies (kind, tool_use_id, detail, detected_at_ms) VALUES (?, ?, ?, ?)');
  anomaly.run('reReadLoop', 'tu0', 'x', nowMs - 3_600_000);
  anomaly.run('zeroEditBurn', 'tu0', 'x', nowMs - 3_600_000);
  db.close();
  return path;
}
