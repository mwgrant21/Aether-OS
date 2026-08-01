import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'node:module';
import { readMemories, readMemoryTombstones } from './memoryStore.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function tempMemoryDb(opts: { withMemoriesTable?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-memorystore-'));
  const dbPath = join(dir, 'memory.db');
  if (opts.withMemoriesTable === false) {
    // No tables at all -- simulates a collector that has never opened this store.
    return dbPath.replace('memory.db', 'nonexistent.db');
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL, owner_agent TEXT, kind TEXT NOT NULL, content TEXT NOT NULL,
      status TEXT, salience INTEGER NOT NULL DEFAULT 3, subject TEXT,
      source_kind TEXT NOT NULL, source_run_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      asked_at INTEGER, reference_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE memory_tombstones (
      id INTEGER PRIMARY KEY, scope TEXT NOT NULL, owner_agent TEXT, content TEXT NOT NULL,
      deleted_at INTEGER NOT NULL, cause TEXT NOT NULL, superseded_by INTEGER
    );
  `);
  db.close();
  return dbPath;
}

function insertMemory(dbPath: string, row: Record<string, unknown>): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO memories (scope, owner_agent, kind, content, status, salience, subject,
       source_kind, source_run_id, created_at, updated_at, reference_count)
     VALUES (@scope, @owner_agent, @kind, @content, @status, @salience, @subject,
       @source_kind, @source_run_id, @created_at, @updated_at, @reference_count)`
  ).run({
    owner_agent: null, status: null, subject: null, source_run_id: null, reference_count: 0,
    ...row,
  });
  db.close();
}

function insertTombstone(dbPath: string, row: Record<string, unknown>): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO memory_tombstones (id, scope, owner_agent, content, deleted_at, cause, superseded_by)
     VALUES (@id, @scope, @owner_agent, @content, @deleted_at, @cause, @superseded_by)`
  ).run({ owner_agent: null, superseded_by: null, ...row });
  db.close();
}

describe('readMemories', () => {
  it('reads and maps a shared and a private row, converting seconds to milliseconds', () => {
    const dbPath = tempMemoryDb();
    insertMemory(dbPath, { scope: 'shared', kind: 'decision', content: 'A shared decision.', salience: 4, source_kind: 'run', created_at: 1000, updated_at: 1000 });
    insertMemory(dbPath, { scope: 'private', owner_agent: 'CINDER', kind: 'habit', content: 'A private habit.', salience: 3, source_kind: 'run', created_at: 2000, updated_at: 2000 });

    const rows = readMemories(dbPath);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBe(2);
    const shared = rows!.find((r) => r.scope === 'shared')!;
    expect(shared).toMatchObject({ scope: 'shared', kind: 'decision', content: 'A shared decision.', salience: 4, ownerAgent: null });
    expect(shared.createdAtMs).toBe(1_000_000); // 1000s -> 1,000,000ms
    const priv = rows!.find((r) => r.scope === 'private')!;
    expect(priv).toMatchObject({ scope: 'private', ownerAgent: 'CINDER', kind: 'habit' });
  });

  it('returns an empty array (not null) when the memories table exists but has no rows', () => {
    const dbPath = tempMemoryDb();
    expect(readMemories(dbPath)).toEqual([]);
  });

  it('returns null when the database file does not exist', () => {
    const dbPath = tempMemoryDb({ withMemoriesTable: false });
    expect(readMemories(dbPath)).toBeNull();
  });
});

describe('readMemoryTombstones', () => {
  it('reads and maps a tombstone row, converting seconds to milliseconds', () => {
    const dbPath = tempMemoryDb();
    insertTombstone(dbPath, { id: 1, scope: 'private', owner_agent: 'CINDER', content: 'Old content.', deleted_at: 3000, cause: 'superseded', superseded_by: 2 });

    const rows = readMemoryTombstones(dbPath);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBe(1);
    expect(rows![0]).toMatchObject({ id: 1, scope: 'private', ownerAgent: 'CINDER', content: 'Old content.', cause: 'superseded', supersededBy: 2 });
    expect(rows![0].deletedAtMs).toBe(3_000_000);
  });

  it('returns null when the database file does not exist', () => {
    const dbPath = tempMemoryDb({ withMemoriesTable: false });
    expect(readMemoryTombstones(dbPath)).toBeNull();
  });
});
