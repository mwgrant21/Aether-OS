// electron/severity/durationBaseline.ts
// Per-subagentType duration baseline for live narration, persisted to
// ~/.aether-os/duration-baseline.json (spec 2026-09-30-real-severity-design.md
// section 6). Wired into main.ts's live narration via liveSeverity.ts; it
// replaced the deleted electron/durationBaseline.ts, which was in-memory, lost
// everything on restart and had no minimum. Holds numbers only, keyed by
// agent type, in a Map so a key like __proto__ is plain data. Written through
// atomicWrite.ts so it inherits the #99 user-only directory ACL. A corrupt,
// wrong-shape or unreadable file starts empty with one [diag] line; a missing
// file is just a first run.
//
// Live path only: NOT in scripts/sync-severity-core.mjs CORE_FILES, because
// the collector computes its median from SQLite, not from this file.
import { readFileSync } from 'node:fs';
import { writeFileAtomically } from '../atomicWrite';
import { BASELINE_WINDOW, isAdmissibleSample, medianOf } from './baselineMath';
import type { DispatchOutcome } from './parseDispatchOutcome';

export const DURATION_BASELINE_FILE = 'duration-baseline.json';
const FILE_VERSION = 1;

export interface DurationBaselineStore {
  medianFor(key: string): number | null;
  record(key: string, outcome: DispatchOutcome): boolean;
  flush(): Promise<void>;
}

export interface DurationBaselineOptions {
  filePath: string;
  diag: (line: string) => void;
  writeFile?: (path: string, content: string) => Promise<void>;
  readFile?: (path: string) => string;
}

function parseSamples(raw: string): Map<string, number[]> | null {
  let json: unknown;
  try {
    json = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const { version, samples } = json as { version?: unknown; samples?: unknown };
  if (version !== FILE_VERSION || !samples || typeof samples !== 'object' || Array.isArray(samples)) return null;
  const out = new Map<string, number[]>();
  for (const [key, value] of Object.entries(samples as Record<string, unknown>)) {
    if (!Array.isArray(value)) return null;
    if (!value.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) return null;
    out.set(key, (value as number[]).slice(-BASELINE_WINDOW));
  }
  return out;
}

function errCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

export function loadDurationBaseline(opts: DurationBaselineOptions): DurationBaselineStore {
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const writeFile = opts.writeFile ?? writeFileAtomically;
  let samples = new Map<string, number[]>();

  let raw: string | null = null;
  try {
    raw = readFile(opts.filePath);
  } catch (err) {
    if (errCode(err) !== 'ENOENT') {
      opts.diag(`[diag] duration-baseline unreadable, starting empty code=${errCode(err)} at=${new Date().toISOString()}`);
    }
  }
  if (raw !== null) {
    const parsed = parseSamples(raw);
    if (parsed) samples = parsed;
    else opts.diag(`[diag] duration-baseline corrupt, starting empty at=${new Date().toISOString()}`);
  }

  let pending: Promise<void> = Promise.resolve();
  // Last write-failure code already reported; cleared by a successful write so
  // a persistent failure logs once per distinct code, not once per record().
  let reportedFailure: string | null = null;
  function persist(): void {
    const content = JSON.stringify({ version: FILE_VERSION, samples: Object.fromEntries(samples) });
    pending = pending
      .then(() => writeFile(opts.filePath, content))
      .then(() => {
        reportedFailure = null;
      })
      .catch((err) => {
        const code = errCode(err);
        if (code === reportedFailure) return;
        reportedFailure = code;
        try {
          opts.diag(`[diag] duration-baseline write failed code=${code} at=${new Date().toISOString()}`);
        } catch {
          // diag must never break the write chain or reject flush().
        }
      });
  }

  return {
    medianFor(key) {
      return medianOf(samples.get(key) ?? []);
    },
    record(key, outcome) {
      const durationMs = outcome.usage?.durationMs;
      if (!isAdmissibleSample(outcome) || durationMs === undefined) return false;
      samples.set(key, [...(samples.get(key) ?? []), durationMs].slice(-BASELINE_WINDOW));
      persist();
      return true;
    },
    flush() {
      return pending;
    },
  };
}
