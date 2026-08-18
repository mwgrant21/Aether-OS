import type { PlanUsageTier, PlanUsageSyncResult } from '../src/state/types';

export interface PlanUsageSyncDeps {
  write: (input: string) => void;
  getSnapshot: () => PlanUsageTier | null;
  hasSeenUsagePane: () => boolean;
  reset: () => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

// Same quiescence rule as TokenMonitor's plan:sync (src/main/main.js) and for
// the same reason: /usage repaints an unsettled frame before the model line
// (if any) renders, so a fresh parse alone is not enough signal to Esc.
export async function runPlanUsageSync(deps: PlanUsageSyncDeps): Promise<PlanUsageSyncResult> {
  const before = deps.getSnapshot()?.capturedAtMs ?? 0;
  deps.write('/usage\r');

  const deadline = deps.now() + 10000;
  let lastCapturedAt = before;
  let lastChangeAt: number | null = null;
  let sawAnyFreshParse = false;

  while (deps.now() < deadline) {
    await deps.sleep(250);
    const snap = deps.getSnapshot();
    const capturedAt = snap?.capturedAtMs ?? 0;
    if (capturedAt > before) {
      sawAnyFreshParse = true;
      if (capturedAt !== lastCapturedAt) {
        lastCapturedAt = capturedAt;
        lastChangeAt = deps.now();
      } else if (lastChangeAt !== null && deps.now() - lastChangeAt >= 2000) {
        deps.write('\x1b');
        return { ok: true, tier: snap!.tier, weekModel: snap!.weekModel, capturedAtMs: snap!.capturedAtMs };
      }
    }
  }

  deps.write('\x1b');
  if (sawAnyFreshParse) {
    const snap = deps.getSnapshot()!;
    return { ok: true, tier: snap.tier, weekModel: snap.weekModel, capturedAtMs: snap.capturedAtMs };
  }

  // Deadline hit with no model line ever seen. Distinguish "confirmed Pro"
  // from "the pane never opened at all" (claude not running in this pty,
  // wrong shell, etc.) using the liveness flag.
  const confirmedPro = deps.hasSeenUsagePane();
  deps.reset(); // clears the buffer AND the liveness flag for the next sync
  if (confirmedPro) return { ok: true, tier: 'pro', weekModel: null, capturedAtMs: deps.now() };
  return { ok: false, error: 'could not read /usage' };
}
