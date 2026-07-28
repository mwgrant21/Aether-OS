import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'node:module';
import { readUsageEventsSince } from './collectorStore.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function tempDbWithUsageEvents(rows: { occurred_at_ms: number; model: string | null; input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }[], schemaVersion = 2): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collectorstore-'));
  const dbPath = join(dir, 'test.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at_ms INTEGER NOT NULL, model TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_creation_input_tokens INTEGER NOT NULL, cache_read_input_tokens INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run(String(schemaVersion));
  const insert = db.prepare(
    'INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const r of rows) {
    insert.run(r.occurred_at_ms, r.model, r.input_tokens, r.output_tokens, r.cache_creation_input_tokens, r.cache_read_input_tokens);
  }
  db.close();
  return dbPath;
}

describe('readUsageEventsSince', () => {
  it('returns mapped events at or after sinceMs, sorted or not (callers do not depend on order)', () => {
    const dbPath = tempDbWithUsageEvents([
      { occurred_at_ms: 1000, model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 },
      { occurred_at_ms: 2000, model: null, input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ]);
    const events = readUsageEventsSince(dbPath, 0);
    expect(events).not.toBeNull();
    expect(events!.length).toBe(2);
    expect(events![0]).toEqual({
      kind: 'assistant',
      timestamp: new Date(1000),
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 10 },
    });
  });

  it('excludes events strictly before sinceMs', () => {
    const dbPath = tempDbWithUsageEvents([
      { occurred_at_ms: 1000, model: null, input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      { occurred_at_ms: 5000, model: null, input_tokens: 2, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ]);
    const events = readUsageEventsSince(dbPath, 3000);
    expect(events!.length).toBe(1);
    expect(events![0].timestamp).toEqual(new Date(5000));
  });

  it('returns null when the database file does not exist', () => {
    const missingPath = join(tmpdir(), 'aether-collectorstore-missing-' + Date.now(), 'test.db');
    expect(readUsageEventsSince(missingPath, 0)).toBeNull();
  });

  it('returns null when schema_meta version is below 2', () => {
    const dbPath = tempDbWithUsageEvents([], 1);
    expect(readUsageEventsSince(dbPath, 0)).toBeNull();
  });

  it('never throws even against a malformed/corrupt database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-collectorstore-corrupt-'));
    const dbPath = join(dir, 'test.db');
    require('fs').writeFileSync(dbPath, 'not a real sqlite file');
    expect(() => readUsageEventsSince(dbPath, 0)).not.toThrow();
    expect(readUsageEventsSince(dbPath, 0)).toBeNull();
  });
});
