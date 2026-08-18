import { stripAnsi } from './ansiStrip';
import type { PlanUsageTier } from '../src/state/types';

const BUFFER_CAP = 16384;
// Matches TokenMonitor's usageParser.js WEEK_MODEL_RE exactly -- same TUI,
// same calibration history (see that file's own comment for why the
// pattern is shaped this way).
const WEEK_MODEL_RE = /Current week \((?!all models)[^)]+\)[\s\S]{0,150}?(\d{1,3})\s*%\s*used/i;

// Liveness-only signal, reusing TokenMonitor's own SESSION_RE calibration --
// NOT used for its percentage (state.statusline already has that), only to
// prove the /usage pane actually opened at all.
const SESSION_SEEN_RE = /Current session/i;

function matchLast(re: RegExp, text: string): RegExpExecArray | null {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null = null;
  let cur: RegExpExecArray | null;
  while ((cur = g.exec(text)) !== null) m = cur;
  return m;
}

export function createPlanUsageScraper(now: () => number = Date.now) {
  let buffer = '';
  let snapshot: PlanUsageTier | null = null;
  let sawUsagePane = false;

  function ingest(chunk: string): void {
    try {
      buffer = (buffer + stripAnsi(chunk)).slice(-BUFFER_CAP);
      if (SESSION_SEEN_RE.test(buffer)) sawUsagePane = true;
      const model = matchLast(WEEK_MODEL_RE, buffer);
      if (model) {
        const pct = Number(model[1]);
        if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
          snapshot = { tier: 'max', weekModel: { pct }, capturedAtMs: now() };
        }
      }
    } catch {
      /* parsing must never break the pty data path -- same rule as TokenMonitor's scraper */
    }
  }

  function getSnapshot(): PlanUsageTier | null {
    return snapshot;
  }

  /** True once any /usage pane text has been seen since the last reset() --
   *  distinguishes "confirmed Pro" from "the pane never opened." */
  function hasSeenUsagePane(): boolean {
    return sawUsagePane;
  }

  function reset(): void {
    buffer = '';
    snapshot = null;
    sawUsagePane = false;
  }

  return { ingest, getSnapshot, hasSeenUsagePane, reset };
}
