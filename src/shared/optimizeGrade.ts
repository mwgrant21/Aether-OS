import { OptimizeFinding, summarizeOptimize } from './optimizeRules';

export { summarizeOptimize };

export const BAD_THRESHOLD_PER_WEEK = 25;

export interface GradeRow {
  key: string;
  label: string;
  status: 'good' | 'warn' | 'bad';
  note: string;
  scored: boolean;
}

interface Factor {
  key: string;
  label: string;
  findingId: 'opus-on-trivial-turns' | 'unpinned-config-re-reads' | 'uncapped-bash-output';
  goodNote: string;
  fixNote: string;
}

const FACTORS: Factor[] = [
  {
    key: 'model-routing',
    label: 'Model routing',
    findingId: 'opus-on-trivial-turns',
    goodNote: 'Right-sized models on trivial turns.',
    fixNote: 'Route trivial turns to a smaller model',
  },
  {
    key: 'file-pinning',
    label: 'File pinning',
    findingId: 'unpinned-config-re-reads',
    goodNote: 'Config files pinned, not re-read.',
    fixNote: 'Pin frequently re-read files into context',
  },
  {
    key: 'output-caps',
    label: 'Output caps',
    findingId: 'uncapped-bash-output',
    goodNote: 'Command output kept lean.',
    fixNote: 'Cap large command output',
  },
];

// gradeBreakdown({ findings, cacheHitRate }) -> 4 rows { key, label, status, note }
export function gradeBreakdown(input?: { findings?: OptimizeFinding[]; cacheHitRate?: number }): GradeRow[] {
  const { findings, cacheHitRate } = input || {};
  const list = Array.isArray(findings) ? findings : [];

  // scored: true rows are the ones summarizeOptimize's $/wk total (and thus the
  // Setup letter grade) is actually computed from. Context hygiene is a real,
  // useful signal but has no $/wk figure behind it, so it is NOT part of the
  // grade math - it must be visually and textually distinct from these three,
  // or "3 green / 1 red" reads as "grade should be worse" when it has no effect.
  const rows = FACTORS.map((f) => {
    const hit = list.find((x) => x && x.id === f.findingId);
    if (!hit) {
      return { key: f.key, label: f.label, status: 'good' as const, note: f.goodNote, scored: true };
    }
    const perWeek = Number.isFinite(hit.estSavingsPerWeek) ? hit.estSavingsPerWeek : 0;
    return {
      key: f.key,
      label: f.label,
      status: perWeek >= BAD_THRESHOLD_PER_WEEK ? ('bad' as const) : ('warn' as const),
      note: `${f.fixNote} (~$${Math.round(perWeek)}/wk reclaimable)`,
      scored: true,
    };
  });

  let hygiene: { status: 'good' | 'warn' | 'bad'; note: string };
  if (typeof cacheHitRate !== 'number' || !Number.isFinite(cacheHitRate)) {
    hygiene = { status: 'warn', note: 'Cache hit rate unknown.' };
  } else {
    const pct = Math.round(cacheHitRate * 100);
    if (cacheHitRate >= 0.7) {
      hygiene = { status: 'good', note: `Cache hit ${pct}% - context reuse healthy.` };
    } else if (cacheHitRate >= 0.4) {
      hygiene = { status: 'warn', note: `Cache hit ${pct}% - pin stable context to lift it.` };
    } else {
      hygiene = { status: 'bad', note: `Cache hit ${pct}% - context churn is expensive.` };
    }
  }
  rows.push({ key: 'context-hygiene', label: 'Context hygiene', ...hygiene, scored: false });
  return rows;
}

// appliedSummary(findings) -> { count, totalPerWeek } over applied findings
export function appliedSummary(findings?: (OptimizeFinding & { applied?: boolean })[]): {
  count: number;
  totalPerWeek: number;
} {
  const applied = (Array.isArray(findings) ? findings : []).filter((f) => f && f.applied === true);
  return {
    count: applied.length,
    totalPerWeek: applied.reduce((s, f) => s + (Number.isFinite(f.estSavingsPerWeek) ? f.estSavingsPerWeek : 0), 0),
  };
}
