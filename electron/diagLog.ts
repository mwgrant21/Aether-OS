import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PurgeResult } from './retentionStore';

export interface DiagLogOptions {
  dir: string;
  fileName?: string;
  maxBytes?: number;
}

export interface DiagLog {
  write(line: string): void;
  /** Settings → Purge: delete diag.log and diag.log.1. Never throws. */
  purge(): PurgeResult;
}

/**
 * Persists `[diag]` lines so they survive the window closing (the installed
 * app has no console). Sync appends: events are rare and a sync write gets the
 * last line out before a crash. fs errors never throw; a failing fs logs once.
 */
export function createDiagLog(opts: DiagLogOptions): DiagLog {
  const { dir, fileName = 'diag.log', maxBytes = 1_000_000 } = opts;
  const file = join(dir, fileName);
  const rotated = `${file}.1`;
  let failureReported = false;
  let permsRepaired = false;

  function reportFailure(err: unknown): void {
    if (failureReported) return;
    failureReported = true;
    try {
      console.error(`[diag] diag.log write failed: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      // nothing further to do
    }
  }

  function rotateIfFull(): void {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return; // no file yet
    }
    if (size >= maxBytes) renameSync(file, rotated); // replaces an existing .1
  }

  // docs/privacy-and-data.md §7: ~/.aether-os is user-only. The modes below
  // only apply when a file or dir is created, so a log an older build left
  // 0644 is tightened once per run. POSIX only: Windows ignores these modes and
  // relies on the profile's inherited ACL; the explicit-ACL promise for the
  // whole directory is tracked as its own issue, not diag.log's job.
  function repairPermsOnce(): void {
    if (permsRepaired) return;
    permsRepaired = true;
    if (process.platform === 'win32') return;
    for (const f of [file, rotated]) if (existsSync(f)) chmodSync(f, 0o600);
  }

  return {
    write(line: string): void {
      console.error(line);
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        try {
          repairPermsOnce();
        } catch (err) {
          reportFailure(err);
        }
        try {
          rotateIfFull();
        } catch (err) {
          // e.g. diag.log.1 held open on Windows: still append; the file may
          // exceed the cap until the rename works.
          reportFailure(err);
        }
        appendFileSync(file, line + '\n', { mode: 0o600 });
      } catch (err) {
        reportFailure(err);
      }
    },
    purge(): PurgeResult {
      // Renderer error text can carry content, so the privacy control has to
      // reach these files too. Try both; report every failure, keep going.
      const errors: string[] = [];
      for (const f of [file, rotated]) {
        try {
          rmSync(f, { force: true });
        } catch (err) {
          errors.push(`${f}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return errors.length ? { ok: false, error: errors.join('; ') } : { ok: true };
    },
  };
}
