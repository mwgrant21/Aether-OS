/**
 * Aether OS — Layer 2 agent memory store.
 *
 * Design: AETHER_MEMORY_LAYER_2.md §3 (schema), §4 (write path), §5 (invalidation).
 *
 * RUNS IN THE COLLECTOR PROCESS (`collector/`, Node >=22.5), NOT IN ELECTRON MAIN.
 *
 * The reason is the single-writer invariant, not the toolchain. Layer 1 §10
 * requires that agents propose and STEWARD commits; across a process boundary
 * that is structural, in-process it is a convention any IPC handler can break
 * by accident. That is why there is deliberately no optimistic locking here.
 *
 * (An earlier version of this comment said the placement was forced because
 * `better-sqlite3` could not be built on this machine. MSVC was installed
 * 2026-07-27 and that reason evaporated; the decision did not, because it never
 * actually rested on it. `node:sqlite` also went release candidate in Node
 * v25.7 — no longer experimental. Electron 31 still ships Node 20, so it
 * remains unavailable in main regardless.)
 *
 * Ported from Miriels-publish/data/memory-store.js. Divergences are marked
 * `// DIVERGENCE:` with the reason, so the port boundary stays legible.
 */

import type { DatabaseSync } from 'node:sqlite';
// Binding convention for this whole package (PROGRESS.md, Collector Foundation
// note (f)): `node:sqlite` may ONLY be imported as a TYPE here. A static value
// import fails under vitest's Vite transform, because Vite 5's dependency
// scanner does not recognise the newer builtin. `openDatabase` does the
// runtime `createRequire` and is the single place that knows this.
import { openDatabase } from './schema.js';

// ---------------------------------------------------------------------------
// Types (§3.3)
// ---------------------------------------------------------------------------

export type MemoryScope = 'shared' | 'private';

export type MemoryKind =
  // SHARED — your standing judgments. Written by the shared writer only.
  //
  // A third kind, 'constraint', was specified and then removed (§9 #3). Every
  // candidate member turned out to be either probe-settleable — P2 says that
  // is a lookup, not memory — or silently-changing world state, which is what
  // P3 forbids outright. The canonical example ("no VS Build Tools on this
  // box") was falsified the day after it was written down. A kind with no
  // legitimate members should not exist; do not add it back without one.
  | 'decision'
  | 'preference'
  // PRIVATE — an agent's own history with you, in its own domain.
  | 'overrule'
  | 'habit'
  | 'revision';

export type MemoryStatus = 'open' | 'moving' | 'settled';
export type SourceKind = 'run' | 'operator' | 'backfill';
export type RevisionCause = 'new_evidence' | 'reasoning_flaw';
export type DeleteCause = 'superseded' | 'operator' | 'invalidated';
export type LinkRelation = 'supersedes' | 'revises';

export const SHARED_KINDS: readonly MemoryKind[] = ['decision', 'preference'];
export const PRIVATE_KINDS: readonly MemoryKind[] = ['overrule', 'habit', 'revision'];
export const KINDS: readonly MemoryKind[] = [...SHARED_KINDS, ...PRIVATE_KINDS];
export const STATUSES: readonly MemoryStatus[] = ['open', 'moving', 'settled'];
export const SOURCE_KINDS: readonly SourceKind[] = ['run', 'operator', 'backfill'];
export const REVISION_CAUSES: readonly RevisionCause[] = ['new_evidence', 'reasoning_flaw'];

/** The one identity permitted to write shared scope (Layer 1 §10). */
export const SHARED_WRITER = 'STEWARD';

export interface MemoryRow {
  id: number;
  scope: MemoryScope;
  owner_agent: string | null;
  kind: MemoryKind;
  content: string;
  status: MemoryStatus | null;
  salience: number;
  subject: string | null;
  source_kind: SourceKind;
  source_run_id: string | null;
  created_at: number;
  updated_at: number;
  asked_at: number | null;
  reference_count: number;
}

export interface TombstoneRow {
  id: number;
  scope: MemoryScope;
  owner_agent: string | null;
  content: string;
  deleted_at: number;
  cause: DeleteCause;
  superseded_by: number | null;
}

// ---------------------------------------------------------------------------
// Operations (§4.1)
// ---------------------------------------------------------------------------

export interface AddOp {
  op: 'ADD';
  kind: MemoryKind;
  content: string;
  status?: MemoryStatus;
  salience?: number;
  subject?: string;
  /** Required for private scope; must equal the writer. Omit for shared. */
  owner_agent?: string;
}

export interface UpdateOp {
  op: 'UPDATE';
  id: number;
  content?: string;
  status?: MemoryStatus;
  salience?: number;
  subject?: string;
}

export interface SupersedeOp {
  op: 'SUPERSEDE';
  id: number;
  content: string;
  kind?: MemoryKind;
  status?: MemoryStatus;
  salience?: number;
  subject?: string;
}

export interface ReviseOp {
  op: 'REVISE';
  /** The row whose position changed. */
  id: number;
  cause: RevisionCause;
  /** The specific fact or flaw that moved it. Layer 1 §7 — not optional. */
  detail: string;
}

export interface TouchOp {
  op: 'TOUCH';
  id: number;
}

export type MemoryOp = AddOp | UpdateOp | SupersedeOp | ReviseOp | TouchOp;

export type RejectReason =
  | 'unknown_op'
  | 'invalid_kind'
  | 'invalid_status'
  | 'empty_content'
  | 'not_found'
  | 'scope_violation'
  | 'forbidden_content'
  | 'missing_revision_cause'
  /** Present but non-numeric. Out-of-range values clamp silently and by design. */
  | 'invalid_salience';

export interface Reject {
  /** The offending operation, verbatim. */
  op: unknown;
  reason: RejectReason;
  /** Which specific rule tripped. Superset of §4.2; costs nothing, saves hours. */
  detail?: string;
}

export interface ApplyResult {
  added: number;
  updated: number;
  superseded: number;
  revised: number;
  touched: number;
  /**
   * DIVERGENCE: Miriel's applyOps silently `continue`s past invalid ops.
   * Layer 1 §7 requires the runtime to *detect* a position change without a
   * Revision — a swallowed reject means it detects nothing and Phase 2 schema
   * validation validates an already-censored stream. Rejects are returned.
   *
   * Scope of the guarantee, precisely: every `RejectReason` is returned rather
   * than skipped. It is NOT a guarantee that nothing is ever coerced (an
   * out-of-range salience clamps by design) nor that a result always comes
   * back (a SQLite-level throw rolls the whole batch back and propagates, and
   * the caller gets an exception instead of an ApplyResult).
   */
  rejected: Reject[];
}

export interface WriteContext {
  /** SHARED_WRITER for shared scope, or the agent_id for its own private scope. */
  writer: string;
  sourceKind: SourceKind;
  sourceRunId?: string | null;
}

// ---------------------------------------------------------------------------
// Forbidden content (§3.4)
// ---------------------------------------------------------------------------

const FILE_EXTENSIONS =
  'ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|swift|php|sh|ps1|bat|sql|json|ya?ml|toml|ini|md|css|scss|html?';

/**
 * Each rule is a location- or payload-leak that P3 forbids, or a suppression
 * rule (§10's nastiest failure mode). A prompt rule is a request; this is the
 * guarantee. Ordered most-specific-first so `detail` names the real cause.
 */
const FORBIDDEN_RULES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'suppression_rule', re: /\b(?:do(?:n'?t| not)|never|stop|no longer|quit)\s+(?:\w+\s+){0,2}(?:flag|flagging|report|reporting|mention|mentioning|surface|surfacing|raise|raising|bring up|bringing up|warn|warning|complain|complaining)\b/i },
  { name: 'suppression_rule', re: /\b(?:ignore|suppress|skip|silence)\s+(?:all\s+|any\s+|these\s+|those\s+)?\w+\s*(?:warnings?|findings?|issues?|errors?|checks?)\b/i },
  { name: 'code_fence', re: /```/ },
  { name: 'absolute_path', re: /(?:[A-Za-z]:\\|\\\\|(?:^|\s)\/)[\w.$-]+[\\/][\w.$-]/ },
  { name: 'line_reference', re: /\b(?:line|lines|ln|L)\s?#?\d{1,6}\b/i },
  { name: 'file_path', re: new RegExp(`\\b[\\w.$-]+\\.(?:${FILE_EXTENSIONS})\\b`, 'i') },
  { name: 'path_line_pair', re: /[\w.$-]+:\d{1,6}\b/ },
  { name: 'shell_command', re: /(?:^|\s)(?:npm|npx|pnpm|yarn|git|node|python3?|pip|cargo|go|docker|kubectl|tsc|vitest|jest)\s+[a-z-]{2,}/i },
];

export function findForbiddenContent(content: string): string | null {
  for (const rule of FORBIDDEN_RULES) {
    if (rule.re.test(content)) return rule.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Private scoring (§4.4, Phase C)
// ---------------------------------------------------------------------------

/**
 * Weights/half-lives below are Phase C's initial defaults, not tuned values
 * -- Phase E ("parked, needs real traffic") owns tuning. Every constant here
 * is named and isolated specifically so that tuning is a numbers-only change,
 * never a structural one. See
 * docs/superpowers/specs/2026-07-31-memory-layer2-phase-c-retrieval-design.md §1.
 */

// Partial, not a full Record<MemoryKind, number>: shared kinds ('decision',
// 'preference') never reach this function -- getPrivateCandidates only ever
// queries scope='private' rows -- so they have no entry here.
const KIND_WEIGHT: Partial<Record<MemoryKind, number>> = {
  overrule: 1.0,
  revision: 0.67,
  habit: 0.33,
};

const RECENCY_HALF_LIFE_DAYS = 90;
const STALENESS_HALF_LIFE_DAYS = 90;
const SECONDS_PER_DAY = 86_400;

/**
 * score = 2.0*kind_weight + 1.5*salience(norm) + 1.0*recency - 0.5*staleness_risk
 *
 * `nowSeconds` matches the store's own now() convention exactly (seconds,
 * not milliseconds) -- see this file's `now` in MemoryStoreOptions. Pure,
 * no I/O, independently testable without a store.
 *
 * DIVERGENCE from Miriel: no `overuse` term. §4.4: "an agent that keeps
 * reaching for the same overrule is an agent that keeps hitting the same
 * wall, and that is signal, not noise."
 */
export function scorePrivateCandidate(row: MemoryRow, nowSeconds: number): number {
  const kindWeight = KIND_WEIGHT[row.kind] ?? 0;
  const salienceNorm = row.salience / 5;

  // Keyed on created_at, NEVER updated_at or a "last surfaced" timestamp --
  // §4.4's own documented trap: surfacing a memory must never raise its own
  // future score.
  const ageDaysSinceCreated = (nowSeconds - row.created_at) / SECONDS_PER_DAY;
  const recency = Math.pow(0.5, ageDaysSinceCreated / RECENCY_HALF_LIFE_DAYS);

  // Zero for any non-'open' status. Keyed on updated_at, which TOUCH
  // legitimately resets -- a TOUCHed open row's staleness_risk resetting is
  // correct (the extractor re-confirmed it's still live), not the same
  // feedback trap as recency/surfacing.
  const ageDaysSinceUpdated = (nowSeconds - row.updated_at) / SECONDS_PER_DAY;
  const stalenessRisk =
    row.status === 'open' ? 1 - Math.pow(0.5, ageDaysSinceUpdated / STALENESS_HALF_LIFE_DAYS) : 0;

  return 2.0 * kindWeight + 1.5 * salienceNorm + 1.0 * recency - 0.5 * stalenessRisk;
}

// ---------------------------------------------------------------------------
// Schema (§3.2)
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scope           TEXT    NOT NULL,
  owner_agent     TEXT,
  kind            TEXT    NOT NULL,
  content         TEXT    NOT NULL,
  status          TEXT,
  salience        INTEGER NOT NULL DEFAULT 3,
  subject         TEXT,
  source_kind     TEXT    NOT NULL,
  source_run_id   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  asked_at        INTEGER,
  reference_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mem_scope      ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_mem_owner      ON memories(scope, owner_agent);
CREATE INDEX IF NOT EXISTS idx_mem_owner_kind ON memories(scope, owner_agent, kind);

-- DIVERGENCE: no FK / ON DELETE CASCADE (Miriel has both). §5 hard-deletes the
-- superseded row and the audit edge must survive it. Cascading here would
-- destroy the trail that justifies the delete.
CREATE TABLE IF NOT EXISTS memory_links (
  from_id  INTEGER NOT NULL,
  to_id    INTEGER NOT NULL,
  relation TEXT    NOT NULL,
  PRIMARY KEY (from_id, to_id, relation)
);

CREATE TABLE IF NOT EXISTS memory_tombstones (
  id            INTEGER PRIMARY KEY,
  scope         TEXT    NOT NULL,
  owner_agent   TEXT,
  content       TEXT    NOT NULL,
  deleted_at    INTEGER NOT NULL,
  cause         TEXT    NOT NULL,
  superseded_by INTEGER
);

CREATE TABLE IF NOT EXISTS memory_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/**
 * Guarded migrations. `CREATE TABLE IF NOT EXISTS` never alters an existing
 * table, so every column added after schema rev 1 needs a guarded ALTER here.
 *
 * Honest status: the one entry below is currently DEAD CODE — `asked_at` is
 * already in the base CREATE, so the branch cannot fire on any database this
 * file created. It is scaffolding, kept so the first real migration has an
 * obvious and already-correct place to go, and so the guard pattern is present
 * before it is needed rather than after. It is not evidence the mechanism has
 * been exercised; the first genuine ALTER is the test of that.
 */
function migrate(db: DatabaseSync): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('asked_at')) db.exec('ALTER TABLE memories ADD COLUMN asked_at INTEGER');
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface MemoryStoreOptions {
  /** Injectable clock (seconds). Tests pin time; production omits it. */
  now?: () => number;
}

/**
 * NOTE THE SEPARATE DATABASE FILE. This must NOT share `collector.db`.
 *
 * The collector database's defining behaviour is retention: `retention.ts`
 * rolls raw `events` rows into `daily_rollups` and then DELETES them past a
 * 30-day window, and Settings exposes a real Purge action over the same store
 * (`privacy-and-data.md` §6). Both are correct for telemetry and catastrophic
 * for memory — a standing decision must survive every purge and every
 * retention sweep. Same lifecycle, same file; different lifecycle, different
 * file. Default: `~/.aether-os/memory.db` beside `~/.aether-os/collector.db`.
 */
export function createMemoryStore(dbPath: string, opts: MemoryStoreOptions = {}) {
  const db = openDatabase(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000'); // DIVERGENCE: Miriel omits this.
  db.exec(SCHEMA);
  migrate(db);

  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  /**
   * Out-of-range clamps silently (an extractor guessing 7 still means "very
   * salient"). Absent defaults to 3. Present-but-non-numeric is NOT clamped —
   * it is a reject, because it means the extractor is emitting the wrong shape
   * and that is signal, not noise. Returns null to signal "reject this op".
   */
  const clampSalience = (n: unknown): number | null => {
    if (n == null) return 3;
    const v = typeof n === 'number' ? Math.trunc(n) : parseInt(String(n), 10);
    if (Number.isNaN(v)) return null;
    return Math.min(5, Math.max(1, v));
  };

  // node:sqlite returns null-prototype objects; normalise so callers can rely
  // on ordinary object semantics (spread, hasOwnProperty, structuredClone).
  const plain = <T>(row: unknown): T => ({ ...(row as object) }) as T;

  const stmtInsert = db.prepare(`
    INSERT INTO memories
      (scope, owner_agent, kind, content, status, salience, subject,
       source_kind, source_run_id, created_at, updated_at)
    VALUES
      (@scope, @owner_agent, @kind, @content, @status, @salience, @subject,
       @source_kind, @source_run_id, @created_at, @updated_at)
  `);
  const stmtGet = db.prepare('SELECT * FROM memories WHERE id = ?');
  const stmtUpdate = db.prepare(`
    UPDATE memories SET
      content    = COALESCE(@content,  content),
      status     = COALESCE(@status,   status),
      salience   = COALESCE(@salience, salience),
      subject    = COALESCE(@subject,  subject),
      updated_at = @updated_at
    WHERE id = @id
  `);
  // TOUCH op: the extractor saw this again and it is still live, so bumping
  // updated_at (which resets §4.4's staleness_risk) is the intended meaning.
  const stmtTouch = db.prepare(
    'UPDATE memories SET reference_count = reference_count + 1, updated_at = ? WHERE id = ?',
  );
  // markReferenced: this row was SURFACED to an agent. It must NOT write
  // updated_at — doing so resets staleness_risk, which would make surfacing a
  // memory raise its own future score. That is exactly the surfacing→score
  // feedback loop §4.4 exists to eliminate, running in the wrong direction.
  // Miriel keeps these two statements separate for the mirror-image reason
  // (stmtMarkRef writes last_referenced_at only); collapsing them is a
  // tempting and wrong simplification.
  const stmtMarkRef = db.prepare(
    'UPDATE memories SET reference_count = reference_count + 1 WHERE id = ?',
  );
  const stmtDelete = db.prepare('DELETE FROM memories WHERE id = ?');
  const stmtTombstone = db.prepare(`
    INSERT OR REPLACE INTO memory_tombstones
      (id, scope, owner_agent, content, deleted_at, cause, superseded_by)
    VALUES (@id, @scope, @owner_agent, @content, @deleted_at, @cause, @superseded_by)
  `);
  const stmtLink = db.prepare(
    'INSERT OR IGNORE INTO memory_links (from_id, to_id, relation) VALUES (?, ?, ?)',
  );

  // §4.4 — shared: unconditional, no scoring, no cap, no relevance filter.
  const stmtShared = db.prepare(`
    SELECT * FROM memories WHERE scope = 'shared'
    ORDER BY kind ASC, salience DESC, created_at ASC
  `);
  // §4.4 — private: candidates for scoring. owner_agent is REQUIRED. No
  // AGENT-FACING read in this file omits it. The unscoped queries below are
  // real and do return private rows — they live behind `admin.*` so that any
  // agent-facing use of them is visible at the call site. That is a guard by
  // convention, not by construction; do not claim otherwise.
  const stmtPrivate = db.prepare(`
    SELECT * FROM memories WHERE scope = 'private' AND owner_agent = ?
    ORDER BY salience DESC, updated_at DESC
    LIMIT ?
  `);
  // Internal pre-filter only, not the final ranking -- scorePrivateCandidate
  // (§4.4, Phase C) does the real ranking in JS after this SQL query bounds
  // the scan. Comfortably above getPrivateCandidates's public default (200)
  // so the pre-filter essentially never discards a row a default-limit caller
  // would have wanted, while still bounding a pathologically large private set.
  const PRIVATE_CANDIDATE_INTERNAL_CAP = 500;

  const stmtAllRows = db.prepare('SELECT * FROM memories ORDER BY created_at DESC');
  const stmtAllTombstones = db.prepare('SELECT * FROM memory_tombstones ORDER BY deleted_at DESC');
  const stmtLinksFor = db.prepare('SELECT * FROM memory_links WHERE from_id = ? OR to_id = ?');
  const stmtGetMeta = db.prepare('SELECT value FROM memory_meta WHERE key = ?');
  const stmtSetMeta = db.prepare(
    'INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );

  function transact<T>(fn: () => T): T {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* rollback of an already-aborted tx is not the interesting error */
      }
      throw e;
    }
  }

  /** Scope of a kind is a property of the kind, never of the caller's claim. */
  function scopeForKind(kind: MemoryKind): MemoryScope {
    return (SHARED_KINDS as readonly string[]).includes(kind) ? 'shared' : 'private';
  }

  function insertRow(args: {
    scope: MemoryScope;
    owner_agent: string | null;
    kind: MemoryKind;
    content: string;
    status: MemoryStatus | null;
    salience: number;
    subject: string | null;
    ctx: WriteContext;
    t: number;
  }): number {
    const info = stmtInsert.run({
      scope: args.scope,
      owner_agent: args.owner_agent,
      kind: args.kind,
      content: args.content,
      status: args.status,
      salience: args.salience,
      subject: args.subject,
      source_kind: args.ctx.sourceKind,
      source_run_id: args.ctx.sourceRunId ?? null,
      created_at: args.t,
      updated_at: args.t,
    });
    return Number(info.lastInsertRowid);
  }

  /** Non-transactional core; callers own the transaction. */
  function supersedeCore(
    old: MemoryRow,
    newId: number,
    cause: DeleteCause,
    t: number,
  ): void {
    stmtTombstone.run({
      id: old.id,
      scope: old.scope,
      owner_agent: old.owner_agent,
      content: old.content,
      deleted_at: t,
      cause,
      superseded_by: newId || null,
    });
    if (newId) stmtLink.run(newId, old.id, 'supersedes');
    stmtDelete.run(old.id);
  }

  /**
   * §4.2 — validate, apply survivors in ONE transaction, return rejects.
   * A reject never aborts the batch; a thrown error rolls the whole thing back.
   */
  function applyOps(ops: unknown, ctx: WriteContext): ApplyResult {
    const result: ApplyResult = {
      added: 0, updated: 0, superseded: 0, revised: 0, touched: 0, rejected: [],
    };
    if (!Array.isArray(ops)) {
      result.rejected.push({ op: ops, reason: 'unknown_op', detail: 'not_an_array' });
      return result;
    }

    const t = now();
    const reject = (op: unknown, reason: RejectReason, detail?: string) => {
      result.rejected.push({ op, reason, detail });
    };

    transact(() => {
      for (const raw of ops) {
        if (!raw || typeof raw !== 'object') {
          reject(raw, 'unknown_op', 'not_an_object');
          continue;
        }
        const op = raw as Record<string, unknown>;
        const kindOfOp = String(op.op ?? '').toUpperCase();

        // -------------------------------------------------------------- ADD
        if (kindOfOp === 'ADD') {
          const kind = op.kind as MemoryKind;
          if (!(KINDS as readonly string[]).includes(kind)) {
            reject(op, 'invalid_kind', String(op.kind)); continue;
          }
          const content = String(op.content ?? '').trim();
          if (!content) { reject(op, 'empty_content'); continue; }

          const forbidden = findForbiddenContent(content);
          if (forbidden) { reject(op, 'forbidden_content', forbidden); continue; }

          if (op.status != null && !(STATUSES as readonly string[]).includes(String(op.status))) {
            reject(op, 'invalid_status', String(op.status)); continue;
          }

          const scope = scopeForKind(kind);
          if (scope === 'shared') {
            if (ctx.writer !== SHARED_WRITER) {
              reject(op, 'scope_violation', `${ctx.writer}_cannot_write_shared`); continue;
            }
            if (op.owner_agent != null) {
              reject(op, 'scope_violation', 'shared_row_with_owner'); continue;
            }
          } else {
            const owner = op.owner_agent == null ? ctx.writer : String(op.owner_agent);
            if (owner !== ctx.writer) {
              reject(op, 'scope_violation', `${ctx.writer}_cannot_write_for_${owner}`); continue;
            }
          }

          const addSalience = clampSalience(op.salience);
          if (addSalience === null) {
            reject(op, 'invalid_salience', String(op.salience)); continue;
          }

          insertRow({
            scope,
            owner_agent: scope === 'shared' ? null : ctx.writer,
            kind,
            content,
            status: op.status != null ? (op.status as MemoryStatus) : null,
            salience: addSalience,
            subject: op.subject != null ? String(op.subject) : null,
            ctx, t,
          });
          result.added++;
          continue;
        }

        // ----------------------------------------------------------- UPDATE
        if (kindOfOp === 'UPDATE') {
          const row = loadWritable(op, reject, ctx);
          if (!row) continue;
          const content = op.content != null ? String(op.content).trim() : null;
          if (op.content != null && !content) { reject(op, 'empty_content'); continue; }
          if (content) {
            const forbidden = findForbiddenContent(content);
            if (forbidden) { reject(op, 'forbidden_content', forbidden); continue; }
          }
          if (op.status != null && !(STATUSES as readonly string[]).includes(String(op.status))) {
            reject(op, 'invalid_status', String(op.status)); continue;
          }
          const updSalience = op.salience != null ? clampSalience(op.salience) : null;
          if (op.salience != null && updSalience === null) {
            reject(op, 'invalid_salience', String(op.salience)); continue;
          }
          stmtUpdate.run({
            id: row.id,
            content,
            status: op.status != null ? String(op.status) : null,
            salience: updSalience,
            subject: op.subject != null ? String(op.subject) : null,
            updated_at: t,
          });
          result.updated++;
          continue;
        }

        // -------------------------------------------------------- SUPERSEDE
        if (kindOfOp === 'SUPERSEDE') {
          const row = loadWritable(op, reject, ctx);
          if (!row) continue;
          const content = String(op.content ?? '').trim();
          if (!content) { reject(op, 'empty_content'); continue; }
          const forbidden = findForbiddenContent(content);
          if (forbidden) { reject(op, 'forbidden_content', forbidden); continue; }

          const kind = (op.kind ?? row.kind) as MemoryKind;
          if (!(KINDS as readonly string[]).includes(kind)) {
            reject(op, 'invalid_kind', String(op.kind)); continue;
          }
          if (scopeForKind(kind) !== row.scope) {
            reject(op, 'scope_violation', 'supersede_changes_scope'); continue;
          }
          if (op.status != null && !(STATUSES as readonly string[]).includes(String(op.status))) {
            reject(op, 'invalid_status', String(op.status)); continue;
          }

          const supSalience = op.salience != null ? clampSalience(op.salience) : row.salience;
          if (supSalience === null) {
            reject(op, 'invalid_salience', String(op.salience)); continue;
          }

          const newId = insertRow({
            scope: row.scope,
            owner_agent: row.owner_agent,
            kind,
            content,
            status: op.status != null ? (op.status as MemoryStatus) : row.status,
            salience: supSalience,
            subject: op.subject != null ? String(op.subject) : row.subject,
            ctx, t,
          });
          supersedeCore(row, newId, 'superseded', t);
          result.superseded++;
          continue;
        }

        // ----------------------------------------------------------- REVISE
        if (kindOfOp === 'REVISE') {
          const row = loadWritable(op, reject, ctx);
          if (!row) continue;
          const cause = String(op.cause ?? '');
          const detail = String(op.detail ?? '').trim();
          // Layer 1 §7: a position change with no named cause is the exact
          // contract breach the runtime exists to catch. Never silent.
          if (!(REVISION_CAUSES as readonly string[]).includes(cause)) {
            reject(op, 'missing_revision_cause', `cause=${op.cause ?? 'absent'}`); continue;
          }
          if (!detail) {
            reject(op, 'missing_revision_cause', 'detail_empty'); continue;
          }
          const forbidden = findForbiddenContent(detail);
          if (forbidden) { reject(op, 'forbidden_content', forbidden); continue; }

          insertRow({
            scope: 'private',
            owner_agent: ctx.writer,
            kind: 'revision',
            content: detail,
            status: 'settled',
            salience: row.salience,
            subject: cause,
            ctx, t,
          });
          const revisionId = Number(
            (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
          );
          stmtLink.run(revisionId, row.id, 'revises');
          result.revised++;
          continue;
        }

        // ------------------------------------------------------------ TOUCH
        if (kindOfOp === 'TOUCH') {
          const row = loadWritable(op, reject, ctx);
          if (!row) continue;
          stmtTouch.run(t, row.id);
          result.touched++;
          continue;
        }

        reject(op, 'unknown_op', kindOfOp || 'absent');
      }
    });

    return result;
  }

  /** Shared read/write gate for id-addressed ops. Returns null after rejecting. */
  function loadWritable(
    op: Record<string, unknown>,
    reject: (op: unknown, reason: RejectReason, detail?: string) => void,
    ctx: WriteContext,
  ): MemoryRow | null {
    const id = typeof op.id === 'number' ? op.id : parseInt(String(op.id ?? ''), 10);
    if (Number.isNaN(id)) { reject(op, 'not_found', 'no_id'); return null; }
    const found = stmtGet.get(id);
    if (!found) { reject(op, 'not_found', `id=${id}`); return null; }
    const row = plain<MemoryRow>(found);
    if (row.scope === 'shared' && ctx.writer !== SHARED_WRITER) {
      reject(op, 'scope_violation', `${ctx.writer}_cannot_write_shared`); return null;
    }
    if (row.scope === 'private' && row.owner_agent !== ctx.writer) {
      reject(op, 'scope_violation', `${ctx.writer}_cannot_write_for_${row.owner_agent}`); return null;
    }
    return row;
  }

  // -------------------------------------------------------------------------
  // Reads (§4.4)
  // -------------------------------------------------------------------------

  /** Every in-force shared judgment. No scoring, no cap — §4.4. */
  function getShared(): MemoryRow[] {
    return stmtShared.all().map((r) => plain<MemoryRow>(r));
  }

  /**
   * Private candidates for one agent, ranked by scorePrivateCandidate (§4.4,
   * Phase C) -- not raw SQL order. `ownerAgent` is required and there is no
   * overload that omits it: cross-agent private reads are impossible by
   * construction, not by convention (Layer 1 §8).
   */
  function getPrivateCandidates(ownerAgent: string, limit = 200): MemoryRow[] {
    if (!ownerAgent) throw new Error('getPrivateCandidates requires an ownerAgent');
    const t = now();
    return stmtPrivate
      .all(ownerAgent, PRIVATE_CANDIDATE_INTERNAL_CAP)
      .map((r) => plain<MemoryRow>(r))
      .map((row) => ({ row, score: scorePrivateCandidate(row, t) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.row);
  }

  function markReferenced(ids: number[]): void {
    if (!ids?.length) return;
    transact(() => { for (const id of ids) stmtMarkRef.run(id); });
  }

  /** Operator-initiated removal. Same hard-delete path as SUPERSEDE (§5). */
  function deleteMemory(id: number, cause: DeleteCause = 'operator'): boolean {
    const found = stmtGet.get(id);
    if (!found) return false;
    const row = plain<MemoryRow>(found);
    const t = now();
    transact(() => supersedeCore(row, 0, cause, t));
    return true;
  }

  // -------------------------------------------------------------------------
  // Admin surface — the Memory view and migrations only. NEVER wired to an
  // agent. These queries ARE unscoped: listAll returns every private row of
  // every agent. Nesting them here does not make cross-agent reads impossible,
  // it makes them conspicuous — `store.admin.listAll()` in agent-facing code is
  // meant to look wrong in review. Every unscoped handle lives under this key
  // for that reason, `_db` included.
  // -------------------------------------------------------------------------
  const admin = {
    listAll: (): MemoryRow[] => stmtAllRows.all().map((r) => plain<MemoryRow>(r)),
    listTombstones: (): TombstoneRow[] => stmtAllTombstones.all().map((r) => plain<TombstoneRow>(r)),
    linksFor: (id: number) =>
      stmtLinksFor.all(id, id).map((r) => plain<{ from_id: number; to_id: number; relation: LinkRelation }>(r)),
    _db: db,
  };

  return {
    applyOps,
    getShared,
    getPrivateCandidates,
    markReferenced,
    deleteMemory,
    getMeta: (k: string) => {
      const r = stmtGetMeta.get(k) as { value: string } | undefined;
      return r ? r.value : null;
    },
    setMeta: (k: string, v: string) => { stmtSetMeta.run(k, String(v)); },
    admin,
    close: () => db.close(),
  };
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;
