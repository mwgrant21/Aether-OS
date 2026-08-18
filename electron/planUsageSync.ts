import type { PlanUsageTier, PlanUsageSyncResult } from '../src/state/types';

export interface PlanUsageSyncDeps {
  write: (input: string) => void;
  getSnapshot: () => PlanUsageTier | null;
  hasSeenUsagePane: () => boolean;
  reset: () => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

// Same quiescence rule as TokenMonitor's plan:sync (main.js) and for the
// same reason: /usage repaints an unsettled frame before the model line
// (if any) renders, so a fresh parse alone is not enough signal to Esc.
export async function runPlanUsageSync(deps: PlanUsageSyncDeps): Promise<PlanUsageSyncResult> {
  // Scope this sync to fresh data only -- a stale buffer, snapshot, or
  // liveness flag left over from a PRIOR sync must never leak into this
  // one's result (a prior Max sync's buffer re-matching would otherwise
  // report stale data as fresh; a prior sync's liveness flag would otherwise
  // survive an unrelated silent sync and misreport Pro).
  deps.reset();
  deps.write('/usage\r');

  const deadline = deps.now() + 10000;
  let lastCapturedAt = 0;
  let lastChangeAt: number | null = null;
  let lastSnap: PlanUsageTier | null = null;

  while (deps.now() < deadline) {
    await deps.sleep(250);
    const snap = deps.getSnapshot();
    if (snap !== null) {
      lastSnap = snap;
      if (snap.capturedAtMs !== lastCapturedAt) {
        lastCapturedAt = snap.capturedAtMs;
        lastChangeAt = deps.now();
      } else if (lastChangeAt !== null && deps.now() - lastChangeAt >= 2000) {
        deps.write('\x1b');
        return { ok: true, tier: lastSnap.tier, weekModel: lastSnap.weekModel, capturedAtMs: lastSnap.capturedAtMs };
      }
    }
  }

  // Deadline reached without quiescence. Only write Escape if the /usage
  // pane is actually confirmed open -- writing it unconditionally would
  // interrupt an unrelated in-flight Claude turn on the ok:false path (the
  // pane never opened at all), which is a destructive side effect the
  // original design never intended.
  const paneOpened = deps.hasSeenUsagePane();
  if (paneOpened) deps.write('\x1b');

  if (lastSnap) {
    // The pty may have died mid-sync (main.ts's pty:exit handler calls
    // reset() independently of this loop, which can land in any sleep()
    // gap above) -- lastSnap still holds the most recent real reading we
    // saw before that happened, which is exactly the spec's documented
    // "accepted limitation: worst case is one stale-but-real reading."
    return { ok: true, tier: lastSnap.tier, weekModel: lastSnap.weekModel, capturedAtMs: lastSnap.capturedAtMs };
  }
  if (paneOpened) {
    // Pane opened and settled with no model line ever appearing -- a
    // confirmed Pro read.
    return { ok: true, tier: 'pro', weekModel: null, capturedAtMs: deps.now() };
  }
  // Pane never opened at all (no claude session in this pty, wrong shell,
  // etc.) -- nothing to close, nothing to report.
  return { ok: false, error: 'could not read /usage' };
}
