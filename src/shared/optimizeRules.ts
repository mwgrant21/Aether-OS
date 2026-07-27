import path from 'node:path';
import { type TranscriptEvent } from '../../electron/transcriptParser';
import { costForEvent, pricingTierForModel, PRICING_PER_MILLION_TOKENS } from './modelPricing';

const TRIVIAL_OUTPUT_TOKEN_THRESHOLD = 100;
const REPEATED_READ_THRESHOLD = 3;
// Cap how many files a single finding enumerates. The rule still counts and
// costs ALL offending files; it only summarizes the DISPLAY so a machine with
// dozens of re-read files can't emit a wall-of-text card that dominates the UI.
const MAX_LISTED_FILES = 3;
const BASH_OUTPUT_SIZE_THRESHOLD = 5000;
const PAGINATION_HINTS = /head|tail|select-object|measure-object|-first|-last/i;

export interface OptimizeFinding {
  id: 'opus-on-trivial-turns' | 'unpinned-config-re-reads' | 'uncapped-bash-output';
  title: string;
  detail: string;
  estSavingsPerWeek: number;
  fixText: string;
}

function extrapolateToWeekly(value: number, windowMs: number): number {
  if (!windowMs) return 0;
  const weeklyFactor = (7 * 24 * 60 * 60 * 1000) / windowMs;
  return value * weeklyFactor;
}

function stringField(input: unknown, field: string): string | undefined {
  if (typeof input !== 'object' || input === null || !(field in input)) return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function findOpusOnTrivialTurns(events: TranscriptEvent[], windowMs: number): OptimizeFinding | null {
  const trivialOpusEvents = events.filter(
    (e) =>
      e.kind === 'assistant' &&
      e.usage &&
      pricingTierForModel(e.model) === 'opus' &&
      e.usage.outputTokens < TRIVIAL_OUTPUT_TOKEN_THRESHOLD,
  );
  if (trivialOpusEvents.length === 0) return null;

  const extraCost = trivialOpusEvents.reduce((sum, e) => {
    const opusCost = costForEvent(e);
    const sonnetCost = costForEvent({ ...e, model: 'claude-sonnet-4-6' });
    return sum + (opusCost - sonnetCost);
  }, 0);

  return {
    id: 'opus-on-trivial-turns',
    title: 'Opus on trivial turns',
    detail: `${trivialOpusEvents.length} turns used Opus for short (<${TRIVIAL_OUTPUT_TOKEN_THRESHOLD}-token) responses`,
    estSavingsPerWeek: extrapolateToWeekly(extraCost, windowMs),
    fixText: 'pin trivial/short turns to Sonnet in CLAUDE.md model guidance',
  };
}

function findUnpinnedConfigRereads(events: TranscriptEvent[], windowMs: number): OptimizeFinding | null {
  const readsByFile = new Map<string, TranscriptEvent[]>();
  for (const e of events) {
    if (e.kind !== 'assistant') continue;
    for (const toolUse of e.toolUses) {
      if (toolUse.name !== 'Read') continue;
      const filePath = stringField(toolUse.input, 'file_path');
      if (!filePath) continue;
      if (!readsByFile.has(filePath)) readsByFile.set(filePath, []);
      readsByFile.get(filePath)!.push(e);
    }
  }

  // Aggregate across ALL offending files into one finding, consistent with
  // findOpusOnTrivialTurns and findUncappedBashOutput (both aggregate across
  // every matching instance rather than reporting only the first).
  const offendingFiles: { filePath: string; count: number }[] = [];
  let totalWastedCost = 0;
  for (const [filePath, reads] of readsByFile.entries()) {
    if (reads.length < REPEATED_READ_THRESHOLD) continue;
    offendingFiles.push({ filePath, count: reads.length });
    totalWastedCost += reads.slice(1).reduce((sum, e) => sum + costForEvent(e), 0);
  }
  if (offendingFiles.length === 0) return null;

  // Show only the worst few offenders by re-read count, using basenames (not
  // full paths) so the card stays one concise line regardless of how many files
  // offend. The total count still reflects every offending file.
  const ranked = offendingFiles.slice().sort((a, b) => b.count - a.count);
  const shown = ranked.slice(0, MAX_LISTED_FILES);
  const moreCount = ranked.length - shown.length;
  // path.win32.basename handles both \ and / separators, so transcripts with
  // Windows paths parse identically when tests run on a posix machine (CI/sandbox).
  const shownList = shown.map((f) => `${path.win32.basename(f.filePath)} (${f.count}x)`).join(', ');
  const fileList = moreCount > 0 ? `${shownList}, +${moreCount} more` : shownList;
  const fixList = shown.map((f) => path.win32.basename(f.filePath)).join(', ');
  return {
    id: 'unpinned-config-re-reads',
    title: 'Unpinned config re-reads',
    detail: `${offendingFiles.length} file(s) re-read without a cache hit: ${fileList}`,
    estSavingsPerWeek: extrapolateToWeekly(totalWastedCost, windowMs),
    fixText: `pin the most re-read files (${fixList}${moreCount > 0 ? ', ...' : ''}) into cached context instead of re-reading`,
  };
}

function findUncappedBashOutput(events: TranscriptEvent[], windowMs: number): OptimizeFinding | null {
  const bashCommandsById = new Map<string, string>();
  for (const e of events) {
    if (e.kind !== 'assistant') continue;
    for (const toolUse of e.toolUses) {
      if (toolUse.name !== 'Bash') continue;
      bashCommandsById.set(toolUse.id, stringField(toolUse.input, 'command') || '');
    }
  }

  let offendingCount = 0;
  let wastedChars = 0;
  for (const e of events) {
    if (e.kind !== 'user') continue;
    for (const result of e.toolResults) {
      const command = bashCommandsById.get(result.toolUseId);
      if (command === undefined) continue;
      const resultLength = result.resultLength || 0;
      if (resultLength > BASH_OUTPUT_SIZE_THRESHOLD && !PAGINATION_HINTS.test(command)) {
        offendingCount += 1;
        wastedChars += resultLength - BASH_OUTPUT_SIZE_THRESHOLD;
      }
    }
  }
  if (offendingCount === 0) return null;

  const estimatedWastedTokens = wastedChars / 4; // ~4 chars per token, rough estimate
  const estimatedCost = (estimatedWastedTokens / 1_000_000) * PRICING_PER_MILLION_TOKENS.sonnet.input;
  return {
    id: 'uncapped-bash-output',
    title: 'Uncapped bash output',
    detail: `${offendingCount} Bash calls returned over ${BASH_OUTPUT_SIZE_THRESHOLD} chars with no output limiting`,
    estSavingsPerWeek: extrapolateToWeekly(estimatedCost, windowMs),
    fixText: 'pipe large commands through head/tail or Select-Object -First',
  };
}

const RULES_BY_ID: Record<OptimizeFinding['id'], (events: TranscriptEvent[], windowMs: number) => OptimizeFinding | null> = {
  'opus-on-trivial-turns': findOpusOnTrivialTurns,
  'unpinned-config-re-reads': findUnpinnedConfigRereads,
  'uncapped-bash-output': findUncappedBashOutput,
};

export function evaluateOptimizeRules(events: TranscriptEvent[], windowMs: number): OptimizeFinding[] {
  const findings = Object.values(RULES_BY_ID).map((rule) => rule(events, windowMs));
  return findings.filter((f): f is OptimizeFinding => f !== null);
}

function eventTimestampMs(e: TranscriptEvent): number {
  return e.timestamp ? e.timestamp.getTime() : NaN;
}

// Once a finding has been applied (an appliedAtMs is on record for its id), a
// stale all-time finding would otherwise show forever: these rules scan every
// event ever recorded, not just the current period, so evidence from before
// the fix never ages out on its own. Re-run that finding's rule against only
// the events AFTER appliedAtMs instead:
//   - no match -> the fix held; drop the finding entirely (caller filters null)
//   - still matches -> genuinely recurring; return the fresh post-fix finding
//     (accurate detail/estimate from new evidence only) tagged recurring:true
// Findings with no recorded appliedAtMs (never applied, or applied by someone
// hand-editing CLAUDE.md outside the Apply-fix action) pass through unchanged.
export function evaluateOptimizeRulesWithRecurrence(
  events: TranscriptEvent[],
  windowMs: number,
  appliedState: Record<string, number>,
): (OptimizeFinding & { recurring?: true; appliedAtMs?: number })[] {
  const state = appliedState || {};
  const findings = evaluateOptimizeRules(events, windowMs);
  return findings
    .map((f) => {
      const appliedAtMs = state[f.id];
      if (!Number.isFinite(appliedAtMs)) return f;

      const rule = RULES_BY_ID[f.id];
      const recentEvents = events.filter((e) => eventTimestampMs(e) > appliedAtMs);
      const recurred = rule ? rule(recentEvents, windowMs) : null;
      if (!recurred) return null;
      return { ...recurred, appliedAtMs, recurring: true as const };
    })
    .filter((f): f is OptimizeFinding & { recurring: true; appliedAtMs: number } => f !== null);
}

export interface OptimizeSummary {
  totalPerWeek: number;
  grade: 'A' | 'B' | 'C' | 'D';
}

// Summarize findings into a total weekly reclaimable spend and a setup grade.
// More reclaimable waste = worse grade (an unoptimized setup leaves money on the table).
export function summarizeOptimize(findings: OptimizeFinding[]): OptimizeSummary {
  const totalPerWeek = (findings || []).reduce(
    (sum, f) => sum + (f && Number.isFinite(f.estSavingsPerWeek) ? f.estSavingsPerWeek : 0),
    0,
  );
  let grade: 'A' | 'B' | 'C' | 'D';
  if (totalPerWeek < 10) grade = 'A';
  else if (totalPerWeek < 25) grade = 'B';
  else if (totalPerWeek < 50) grade = 'C';
  else grade = 'D';
  return { totalPerWeek, grade };
}
