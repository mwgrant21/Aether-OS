import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

export type MemoryScope = 'shared' | 'private';
export type MemoryKind = 'decision' | 'preference' | 'overrule' | 'habit' | 'revision';
export type MemoryStatus = 'open' | 'moving' | 'settled';

export interface MemoryRowUI {
  id: number;
  scope: MemoryScope;
  ownerAgent: string | null;
  kind: MemoryKind;
  content: string;
  status: MemoryStatus | null;
  salience: number;
  subject: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  referenceCount: number;
}

export interface MemoryTombstoneUI {
  id: number;
  scope: MemoryScope;
  ownerAgent: string | null;
  content: string;
  deletedAtMs: number;
  cause: 'superseded' | 'operator' | 'invalidated';
  supersededBy: number | null;
}

function openReadOnly(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  try {
    const sqlite = require('node:sqlite');
    return new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

// memory.db has no schema_meta table (unlike collector.db) -- Phase A's
// migrate() is a guarded-ALTER pattern keyed on PRAGMA table_info, not a
// version counter. Table existence is the liveness signal here: an absent
// `memories` table means the collector has never opened this store.
function hasMemoriesTable(db: DatabaseSync): boolean {
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
      .get();
    return !!row;
  } catch {
    return false;
  }
}

export function readMemories(dbPath: string): MemoryRowUI[] | null {
  const db = openReadOnly(dbPath);
  if (!db) return null;
  try {
    if (!hasMemoriesTable(db)) return null;
    const rows = db
      .prepare(
        `SELECT id, scope, owner_agent, kind, content, status, salience, subject,
                created_at, updated_at, reference_count
         FROM memories ORDER BY scope ASC, kind ASC, salience DESC, created_at ASC`
      )
      .all() as {
      id: number; scope: string; owner_agent: string | null; kind: string; content: string;
      status: string | null; salience: number; subject: string | null;
      created_at: number; updated_at: number; reference_count: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope as MemoryScope,
      ownerAgent: r.owner_agent,
      kind: r.kind as MemoryKind,
      content: r.content,
      status: r.status as MemoryStatus | null,
      salience: r.salience,
      subject: r.subject,
      createdAtMs: r.created_at * 1000,
      updatedAtMs: r.updated_at * 1000,
      referenceCount: r.reference_count,
    }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function readMemoryTombstones(dbPath: string): MemoryTombstoneUI[] | null {
  const db = openReadOnly(dbPath);
  if (!db) return null;
  try {
    if (!hasMemoriesTable(db)) return null;
    const rows = db
      .prepare(
        `SELECT id, scope, owner_agent, content, deleted_at, cause, superseded_by
         FROM memory_tombstones ORDER BY deleted_at DESC`
      )
      .all() as {
      id: number; scope: string; owner_agent: string | null; content: string;
      deleted_at: number; cause: string; superseded_by: number | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope as MemoryScope,
      ownerAgent: r.owner_agent,
      content: r.content,
      deletedAtMs: r.deleted_at * 1000,
      cause: r.cause as MemoryTombstoneUI['cause'],
      supersededBy: r.superseded_by,
    }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}
