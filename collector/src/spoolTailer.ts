import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { decodeLine, insertHookEvent } from './ingest.js';
import type { ParsedHookEvent } from './hookPayload.js';

export interface TailResult {
  /** Files whose lines were all committed (or had nothing to commit) and were deleted. */
  filesProcessed: number;
  linesIngested: number;
  /** Files kept for the next pass because the database refused a write. */
  filesRetained: number;
}

/**
 * Reads every *.jsonl file in the spool, writes each file's events inside ONE
 * transaction, and deletes the file only after that transaction commits.
 *
 * A spool file is the only copy of its hook events, so the delete has to be
 * conditional on the write. Before this, every line's outcome collapsed into
 * a boolean and the file was removed regardless -- a `collector.db` held
 * past busy_timeout by another reader (the Electron app, the Go collector)
 * made every INSERT fail, and the whole file vanished with nothing logged.
 *
 * Two kinds of "not ingested" are treated differently on purpose:
 *   - a line that can NEVER ingest (blank, malformed JSON, unknown shape,
 *     missing required field) is skipped and does not hold the file back;
 *   - a write the database REFUSED rolls the file's transaction back, keeps
 *     the file, logs once, and lets the next pass retry it from scratch.
 * The transaction is what makes that retry safe: `events` has no unique key,
 * so committing half a file and retrying would duplicate the first half.
 *
 * Never throws.
 */
export function tailSpoolOnce(db: DatabaseSync, spoolDir: string, nowMs: number): TailResult {
  let entries: string[];
  try {
    entries = readdirSync(spoolDir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return { filesProcessed: 0, linesIngested: 0, filesRetained: 0 };
  }

  let filesProcessed = 0;
  let linesIngested = 0;
  let filesRetained = 0;

  for (const name of entries) {
    const filePath = join(spoolDir, name);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      // Racing an in-progress append -- leave the file for the next poll.
      continue;
    }

    const events: ParsedHookEvent[] = [];
    for (const line of raw.split('\n')) {
      const event = decodeLine(db, line.trim(), nowMs);
      if (event !== null) events.push(event);
    }

    if (events.length > 0) {
      try {
        writeAll(db, events);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[aether-collector] spool: keeping ${name}, ${events.length} event(s) not written: ${detail}`);
        filesRetained += 1;
        continue;
      }
    }

    linesIngested += events.length;
    filesProcessed += 1;

    try {
      rmSync(filePath, { force: true });
    } catch {
      // If deletion fails after a successful commit, the file's lines get
      // re-ingested next pass -- an events row is not unique-constrained on
      // content, so a rare duplicate insert here is a strictly safer failure
      // mode than losing the file (and its consumption) silently.
    }
  }

  return { filesProcessed, linesIngested, filesRetained };
}

/** All-or-nothing: every event committed, or none and the error rethrown. */
function writeAll(db: DatabaseSync, events: ParsedHookEvent[]): void {
  db.exec('BEGIN');
  try {
    for (const event of events) insertHookEvent(db, event);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The failure already ended the transaction (e.g. the connection is
      // gone); there is nothing left to undo.
    }
    throw err;
  }
}

export function startSpoolTailer(db: DatabaseSync, spoolDir: string, intervalMs: number): () => void {
  const timer = setInterval(() => tailSpoolOnce(db, spoolDir, Date.now()), intervalMs);
  return () => clearInterval(timer);
}
