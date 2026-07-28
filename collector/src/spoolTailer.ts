import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ingestLine } from './ingest';

export function tailSpoolOnce(
  db: DatabaseSync,
  spoolDir: string,
  nowMs: number
): { filesProcessed: number; linesIngested: number } {
  let entries: string[];
  try {
    entries = readdirSync(spoolDir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return { filesProcessed: 0, linesIngested: 0 };
  }

  let filesProcessed = 0;
  let linesIngested = 0;

  for (const name of entries) {
    const filePath = join(spoolDir, name);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      // Racing an in-progress append -- leave the file for the next poll.
      continue;
    }

    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    for (const line of lines) {
      if (ingestLine(db, line, nowMs)) linesIngested += 1;
    }
    filesProcessed += 1;

    try {
      rmSync(filePath, { force: true });
    } catch {
      // If deletion fails, the file's lines get re-ingested next pass -- an
      // events row is not unique-constrained on content, so a rare duplicate
      // insert here is a strictly safer failure mode than losing the file
      // (and its consumption) silently.
    }
  }

  return { filesProcessed, linesIngested };
}

export function startSpoolTailer(db: DatabaseSync, spoolDir: string, intervalMs: number): () => void {
  const timer = setInterval(() => tailSpoolOnce(db, spoolDir, Date.now()), intervalMs);
  return () => clearInterval(timer);
}
