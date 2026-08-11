// src/shared/projectsSnapshot.ts
import type { TranscriptEvent } from '../../electron/transcriptParser';
import { buildLedgerSnapshot, type LedgerSnapshot } from './ledgerMath';
import { resolveProject, type GitProbe } from './projectIdentity';
import { evaluateOptimizeRulesWithRecurrence, summarizeOptimize, type OptimizeFinding, type OptimizeSummary } from './optimizeRules';
import { computeCacheHitRate } from './cacheHitRate';
import { gradeBreakdown, type GradeRow } from './optimizeGrade';

const DEFAULT_OPTIMIZE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // mirrors main.ts's WEEK_MS

export interface ProjectOptimizeSnapshot {
  findings: (OptimizeFinding & { recurring?: true; appliedAtMs?: number })[];
  summary: OptimizeSummary;
  breakdown: GradeRow[];
}

export interface ProjectNode {
  /** Opaque and stable. Never a path -- see docs/privacy-and-data.md. */
  key: string;
  /** Basename only. */
  name: string;
  worktree: string | null;
  ledger: LedgerSnapshot;
  optimize: ProjectOptimizeSnapshot;
}

export interface ProjectRoot extends ProjectNode {
  /**
   * Every checkout of this repo INCLUDING its own, which carries
   * `worktree: null` and displays as "main". The root's `ledger` is built from
   * all of these events, so children sum exactly to the parent.
   */
  children: ProjectNode[];
}

export interface ProjectsSnapshot {
  /** Sorted by cost descending. */
  roots: ProjectRoot[];
  /** Events with no resolvable project. null when there were none. */
  unscoped: LedgerSnapshot | null;
  computedAtMs: number;
}

function buildOptimizeSnapshot(
  events: TranscriptEvent[],
  windowMs: number,
  appliedState: Record<string, number>,
): ProjectOptimizeSnapshot {
  const findings = evaluateOptimizeRulesWithRecurrence(events, windowMs, appliedState);
  const summary = summarizeOptimize(findings);
  const cacheHitRate = computeCacheHitRate(events);
  const breakdown = gradeBreakdown({ findings, cacheHitRate });
  return { findings, summary, breakdown };
}

export function buildProjectsSnapshot(
  events: TranscriptEvent[],
  probe: GitProbe,
  keyOf: (repoPath: string) => string,
  timeZone: string,
  nowMs: number,
  optimizeOptions?: { windowMs: number; appliedState: Record<string, number> },
): ProjectsSnapshot {
  const windowMs = optimizeOptions?.windowMs ?? DEFAULT_OPTIMIZE_WINDOW_MS;
  const appliedState = optimizeOptions?.appliedState ?? {};
  // repoPath -> worktree name (or '' for the repo's own checkout) -> events
  const byRepo = new Map<string, Map<string, TranscriptEvent[]>>();
  const repoNames = new Map<string, string>();
  const unscoped: TranscriptEvent[] = [];

  // Resolution is memoised per cwd: a scan holds tens of thousands of events
  // across a handful of distinct working directories.
  const cache = new Map<string, ReturnType<typeof resolveProject>>();

  for (const event of events) {
    const cwd = event.cwd ?? '';
    let ref = cache.get(cwd);
    if (!cache.has(cwd)) {
      ref = resolveProject(event.cwd, probe);
      cache.set(cwd, ref);
    }
    if (!ref) {
      unscoped.push(event);
      continue;
    }
    repoNames.set(ref.repoPath, ref.repoName);
    let checkouts = byRepo.get(ref.repoPath);
    if (!checkouts) {
      checkouts = new Map();
      byRepo.set(ref.repoPath, checkouts);
    }
    const slot = ref.worktree ?? '';
    const bucket = checkouts.get(slot);
    if (bucket) bucket.push(event);
    else checkouts.set(slot, [event]);
  }

  const roots: ProjectRoot[] = [];
  for (const [repoPath, checkouts] of byRepo) {
    const name = repoNames.get(repoPath)!;
    const children: ProjectNode[] = [];
    const allEvents: TranscriptEvent[] = [];

    for (const [slot, slotEvents] of checkouts) {
      allEvents.push(...slotEvents);
      children.push({
        key: keyOf(`${repoPath}#${slot}`),
        name,
        worktree: slot === '' ? null : slot,
        ledger: buildLedgerSnapshot(slotEvents, timeZone, nowMs),
        optimize: buildOptimizeSnapshot(slotEvents, windowMs, appliedState),
      });
    }

    // The repo's own checkout first, then worktrees by cost descending -- so
    // "main" is a stable anchor rather than jumping position as costs move.
    children.sort((a, b) => {
      if (a.worktree === null) return -1;
      if (b.worktree === null) return 1;
      return b.ledger.total.usd - a.ledger.total.usd;
    });

    roots.push({
      key: keyOf(repoPath),
      name,
      worktree: null,
      ledger: buildLedgerSnapshot(allEvents, timeZone, nowMs),
      optimize: buildOptimizeSnapshot(allEvents, windowMs, appliedState),
      children,
    });
  }

  roots.sort((a, b) => b.ledger.total.usd - a.ledger.total.usd);

  return {
    roots,
    unscoped: unscoped.length > 0 ? buildLedgerSnapshot(unscoped, timeZone, nowMs) : null,
    computedAtMs: nowMs,
  };
}
