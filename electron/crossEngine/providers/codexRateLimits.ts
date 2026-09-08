// BUILT, NOT YET WIRED. Nothing in production calls this module.
//
// `readAccountRateLimits` (codexAppServer.ts) and this parser are reachable
// only from their own tests: `grep -rn "readAccountRateLimits|parseAccountRateLimits"
// electron/ src/` finds no call site in main.ts or any IPC handler, and the
// quota series the Ledger prices is fed exclusively by the Claude statusline
// (statuslineWatcher.ts -> quotaSampleBuffer -> deriveQuotaEfficiency). This
// is verified parsing and transport with no producer attached to it, and the
// whole-branch review flagged that it must not ship looking live.
//
// What remains, if a second sample source is ever wanted:
//   1. A poller in main.ts that calls readAccountRateLimits on an interval,
//      the way statuslineWatcher polls the statusline file.
//   2. A decision about the SERIES, not just the transport: quotaSampleBuffer
//      holds one undifferentiated percentage series and deriveQuotaEfficiency
//      diffs consecutive readings within an hour bucket. Interleaving two
//      accounts' percentages into it would produce meaningless deltas, so a
//      second source needs either its own buffer or a per-source key -- and
//      the Ledger's cards would then have to say which engine they are about.
//   3. Failure semantics: `codex app-server` not being installed is the normal
//      case for a Claude-only machine and must be silent, not an error state.
// That is a feature-sized change with its own review, deliberately NOT done as
// part of a fix wave. The plan for this branch specified the parser and the
// transport and never specified a wiring step -- a plan defect, recorded here
// rather than papered over by wiring it in unreviewed.
//
// Parser for `account/rateLimits/read` on `codex app-server`.
//
// Unlike every other method this directory speaks, there are no generated
// bindings for this one in the repo: `grep -rn "rateLimits"` finds only the
// method-list comment in contract.ts. The shape below is therefore taken from
// the prototyping spec ("request has no params, response includes rate limit
// windows with used percentage and reset time") and parsed the way readUsage
// and parseStatuslinePayload already are -- accept both casings, accept every
// plausible spelling of the reset time, and degrade a field this parser cannot
// read to null rather than discarding the whole readout or throwing.
//
// A percentage with no reset time is still worth keeping: "58% of the weekly
// window is gone" is the number the quota view needs; the reset time only
// feeds the countdown.
import type { RateLimitWindow } from '../../../src/shared/statuslinePayload';
import type { DepletionInput } from '../../../src/shared/depletion';

export interface RateLimitWindowReadout {
  /** 0-100. */
  usedPercentage: number;
  /** The window's length as the server describes it (300 = the 5-hour window,
   *  10080 = the 7-day one). null when absent -- never inferred. */
  windowMinutes: number | null;
  /** Epoch MILLISECONDS, converted from whichever form the server sent. */
  resetsAtMs: number | null;
}

export interface AccountRateLimits {
  capturedAtMs: number;
  /** The shorter, faster-moving window (the 5-hour one on a ChatGPT plan).
   *  Positional -- `asDepletionInput` below double-checks this against
   *  `windowMinutes` before treating either one as the 5-hour gauge. */
  primary: RateLimitWindowReadout | null;
  /** The longer window (the weekly one). Same caveat as `primary`. */
  secondary: RateLimitWindowReadout | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Epoch ms from an epoch-SECONDS number, an ISO string, or a relative
 *  seconds-from-now offset -- in that order of preference. */
function readResetMs(w: Record<string, unknown>, capturedAtMs: number): number | null {
  const absolute = w.resetsAt ?? w.resets_at;
  const seconds = num(absolute);
  if (seconds !== null) return seconds * 1000;
  if (typeof absolute === 'string') {
    const parsed = Date.parse(absolute);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const relative = num(w.resetsInSeconds ?? w.resets_in_seconds);
  if (relative !== null) return capturedAtMs + relative * 1000;
  return null;
}

function readWindow(raw: unknown, capturedAtMs: number): RateLimitWindowReadout | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const w = raw as Record<string, unknown>;
  const usedPercentage = num(w.usedPercent ?? w.used_percent ?? w.usedPercentage ?? w.used_percentage);
  if (usedPercentage === null) return null;
  return {
    usedPercentage,
    windowMinutes: num(w.windowMinutes ?? w.window_minutes ?? w.windowDurationMins ?? w.window_duration_mins),
    resetsAtMs: readResetMs(w, capturedAtMs),
  };
}

/** Never throws. Anything unreadable becomes a null window. */
export function parseAccountRateLimits(raw: unknown, capturedAtMs: number): AccountRateLimits {
  const empty: AccountRateLimits = { capturedAtMs, primary: null, secondary: null };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return empty;
  const outer = raw as Record<string, unknown>;
  // The windows may arrive wrapped (`{ rateLimits: { primary, secondary } }`)
  // or bare. Both are accepted rather than guessed at.
  const wrapped = outer.rateLimits ?? outer.rate_limits;
  const source =
    typeof wrapped === 'object' && wrapped !== null && !Array.isArray(wrapped)
      ? (wrapped as Record<string, unknown>)
      : outer;
  return {
    capturedAtMs,
    primary: readWindow(source.primary, capturedAtMs),
    secondary: readWindow(source.secondary, capturedAtMs),
  };
}

const FIVE_HOUR_WINDOW_MINUTES = 300;

/** Picks the 5-hour window by its reported duration rather than trusting
 *  that `primary` always is it. A real capture (2026-09-07, codex-cli
 *  0.153.2) confirms primary=300min / secondary=10080min, which is the
 *  positional assumption this replaces -- but the binding rule that the
 *  7-day window is the cost basis and the 5-hour window is a live gauge
 *  only, never mixed, is exactly the invariant a reordered response would
 *  silently violate. Falls back to position when neither window reports a
 *  duration (older/defensive shapes still lack `windowMinutes` entirely). */
function pickFiveHourWindow(limits: AccountRateLimits): RateLimitWindowReadout | null {
  const { primary, secondary } = limits;
  if (primary?.windowMinutes == null && secondary?.windowMinutes == null) return primary;
  const distance = (w: RateLimitWindowReadout | null) =>
    w?.windowMinutes == null ? Infinity : Math.abs(w.windowMinutes - FIVE_HOUR_WINDOW_MINUTES);
  // Strict less-than: an exact tie keeps primary. Real data (300 vs 10080)
  // never ties, so this is an untested-but-deliberate default, not an oversight.
  return distance(secondary) < distance(primary) ? secondary : primary;
}

/** The 5-hour window in the shape `deriveDepletion` consumes.
 *
 *  A window with no reset time yields null: every projection in
 *  depletion.ts is anchored to `resetsAtMs` (it derives the window start from
 *  it when the caller supplies none), so handing it a fabricated reset would
 *  produce a confident, wrong countdown rather than an honest "no data". */
export function asDepletionInput(limits: AccountRateLimits): DepletionInput {
  return { capturedAtMs: limits.capturedAtMs, fiveHour: toRateLimitWindow(pickFiveHourWindow(limits)) };
}

export function toRateLimitWindow(readout: RateLimitWindowReadout | null): RateLimitWindow | null {
  if (readout === null || readout.resetsAtMs === null) return null;
  return { usedPercentage: readout.usedPercentage, resetsAtMs: readout.resetsAtMs };
}
