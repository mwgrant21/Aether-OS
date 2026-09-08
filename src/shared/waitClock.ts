// ---------------------------------------------------------------------------
// Measured duration excludes time spent waiting on the human
// ---------------------------------------------------------------------------
//
// A dispatch's reported `<duration_ms>` is wall clock: start to finish,
// including every second the run sat blocked on an approval prompt nobody was
// at the keyboard for. Feeding that into a "slower than usual for this task
// kind" comparison (electron/durationBaseline.ts's medians, consumed by
// narrationGenerator.ts) produces confident, false anomaly narrations whose
// actual cause is that the operator went to lunch mid-run.
//
// So the app records WHEN it was blocking on the user -- a permission prompt,
// a post-tool flag review -- and subtracts the overlap. What is left is time
// the agent was actually working.
//
// Pure and clock-injected throughout: `atMs`/`nowMs` are always parameters,
// never a Date.now() call, so the tests are deterministic and the module can
// live in src/shared/ alongside the rest of the arithmetic.

export interface WaitInterval {
  startMs: number;
  /** null while the wait is still open. */
  endMs: number | null;
}

export interface WaitClock {
  /** Append-ordered. May contain overlaps; waitMsWithin merges before summing. */
  intervals: WaitInterval[];
  /** Open waits by request id, so an out-of-order or duplicate close is safe. */
  open: Map<string, number>;
}

/**
 * Bound on retained CLOSED intervals. A long session answering hundreds of
 * prompts must not grow this without limit, but an open interval is NEVER
 * evicted -- dropping one would silently stop the subtraction for a wait that
 * is still happening, understating a future active duration. Pruning always
 * drops the oldest closed intervals first, keeping the most recent history.
 */
export const MAX_RETAINED_WAITS = 200;

export function createWaitClock(): WaitClock {
  return { intervals: [], open: new Map() };
}

/**
 * Opens a wait. A duplicate id (the same request begins twice before it ends)
 * is IGNORED rather than restarting the clock: an event stream can duplicate
 * a message, and restarting the start time would under-count the wait by
 * discarding the time already elapsed before the duplicate arrived.
 */
export function beginWait(clock: WaitClock, id: string, atMs: number): void {
  if (!Number.isFinite(atMs) || clock.open.has(id)) return;
  const interval: WaitInterval = { startMs: atMs, endMs: null };
  clock.open.set(id, clock.intervals.length);
  clock.intervals.push(interval);
}

/**
 * Closes a wait. An id with no matching open wait is a no-op -- a duplicate
 * or late resume (e.g. arriving after a timeout already force-closed the
 * same id) is expected traffic, not an error, and must not corrupt state.
 *
 * If `atMs` is behind the wait's own start (a backward clock movement),
 * `endMs` is clamped to `startMs` so the STORED interval itself is never
 * negative-width. This is defensive, not the mechanism that keeps
 * waitMsWithin's output non-negative -- that guarantee comes entirely from
 * the per-interval `end > start` filter in waitMsWithin, which independently
 * rejects an inverted interval regardless of what is stored here (confirmed
 * by ablation: removing this clamp changes no test outcome, including the
 * backward-clock test below). Kept anyway because a raw `endMs < startMs`
 * in `intervals` would still be a wrong fact about the world for any future
 * reader that inspects the array directly instead of going through
 * waitMsWithin.
 */
export function endWait(clock: WaitClock, id: string, atMs: number): void {
  const index = clock.open.get(id);
  if (index === undefined) return;
  clock.open.delete(id);
  const interval = clock.intervals[index];
  if (interval && interval.endMs === null && Number.isFinite(atMs)) {
    interval.endMs = Math.max(interval.startMs, atMs);
  }
  prune(clock);
}

/** Drops the oldest CLOSED intervals once the cap is exceeded. Indices in
 *  `open` are re-based, since dropping from the front shifts them. */
function prune(clock: WaitClock): void {
  const closed = clock.intervals.filter((iv) => iv.endMs !== null).length;
  if (closed <= MAX_RETAINED_WAITS) return;
  let toDrop = closed - MAX_RETAINED_WAITS;
  const kept: WaitInterval[] = [];
  for (const interval of clock.intervals) {
    if (toDrop > 0 && interval.endMs !== null) {
      toDrop -= 1;
      continue;
    }
    kept.push(interval);
  }
  const rebased = new Map<string, number>();
  for (const [id, index] of clock.open) {
    const moved = kept.indexOf(clock.intervals[index]);
    if (moved !== -1) rebased.set(id, moved);
  }
  clock.intervals = kept;
  clock.open = rebased;
}

/**
 * Milliseconds inside [spanStartMs, spanEndMs] during which the app was
 * blocked on the user.
 *
 * THIS is where the module's core guarantee actually lives: every interval
 * is clipped to `[max(interval.startMs, spanStartMs), min(interval.endMs ??
 * nowMs, spanEndMs)]` and then dropped unless `end > start`. Because the
 * clipped end can never exceed spanEndMs and the clipped start can never be
 * less than spanStartMs, no interval that survives this filter can exceed
 * the span, and an inverted or degenerate span (spanEndMs <= spanStartMs)
 * forces `end <= start` for every interval and so drops all of them --
 * which is also why the earlier `spanEndMs <= spanStartMs` early return
 * above is itself redundant with this filter (confirmed by ablation) and
 * kept only as a cheap early exit / explicit NaN guard, not as the actual
 * source of correctness. Two overlapping prompts (a permission request and
 * a post-tool flag review are separate resolver maps in main.ts) are then
 * merged rather than summed independently, because summing two overlapping
 * durations would double-count the overlap and could report more waited
 * time than the span actually contains -- merging is what keeps the total
 * bounded by the span's own width, which is in turn what keeps
 * activeDurationMs's result non-negative by construction (see its own
 * comment).
 *
 * A still-open wait counts up to `nowMs`, and stays there: as long as the
 * caller re-derives `wallDurationMs` from the same `nowMs` on every tick,
 * the waited amount grows in lockstep with the wall clock and the resulting
 * active duration (see activeDurationMs) stays frozen for the duration of
 * the wait, not still counting up.
 */
export function waitMsWithin(
  clock: WaitClock,
  spanStartMs: number,
  spanEndMs: number,
  nowMs: number,
): number {
  if (!Number.isFinite(spanStartMs) || !Number.isFinite(spanEndMs) || spanEndMs <= spanStartMs) {
    return 0;
  }

  const clipped: [number, number][] = [];
  for (const interval of clock.intervals) {
    const start = Math.max(interval.startMs, spanStartMs);
    const end = Math.min(interval.endMs ?? nowMs, spanEndMs);
    if (end > start) clipped.push([start, end]);
  }
  if (clipped.length === 0) return 0;

  clipped.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [currentStart, currentEnd] = clipped[0];
  for (let i = 1; i < clipped.length; i += 1) {
    const [start, end] = clipped[i];
    if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
    } else {
      total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    }
  }
  return total + (currentEnd - currentStart);
}

/**
 * The portion of a wall-clock duration during which the agent was actually
 * working, i.e. wall clock minus time spent waiting on the operator.
 *
 * Clamped at zero: a wait recorded around a span it does not really belong
 * to must degrade to "no measurable work time", never to a negative that
 * would then drag a median below zero.
 *
 * `wallDurationMs` is validated on its own (non-finite or <= 0 returns 0 --
 * there is no such thing as a negative or NaN duration to salvage). If
 * `startedAtMs` is not finite there is no anchor to compute overlap against,
 * so this falls back to the wall duration UNCHANGED -- treating an unknown
 * start as "no measured wait", not as "no measured work" (which returning 0
 * would imply). Absent-anchor and zero-active are different facts and must
 * not collapse into the same return value.
 */
export function activeDurationMs(
  clock: WaitClock,
  startedAtMs: number,
  wallDurationMs: number,
  nowMs: number,
): number {
  if (!Number.isFinite(wallDurationMs) || wallDurationMs <= 0) return 0;
  if (!Number.isFinite(startedAtMs)) return wallDurationMs;
  const waited = waitMsWithin(clock, startedAtMs, startedAtMs + wallDurationMs, nowMs);
  return Math.max(0, wallDurationMs - waited);
}
