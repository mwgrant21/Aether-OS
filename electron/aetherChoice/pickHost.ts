// AetherChoice pick host core. Owns the per-slot pick records, builds Aether launch commands,
// tracks launch and exit, turns screen plus quiet signals into the engine's synchronous idle
// reading, drives the engine from a bounded tick and persists every mutation serially.
// Pure of electron, fs, pty and timers: everything arrives through PickHostDeps. The host itself
// never writes to a port; the only writes are the engine's.
import { createApplyEngine } from './applyEngine';
import type { FailureInfo } from './applyEngine';
import { buildAetherLaunchCommand } from './launchCommand';
import { LAUNCH_EFFORTS, MODEL_ALIASES } from '../../src/shared/aetherChoice/types';
import type { IdleReading, LaunchEffort, ModelAlias, Pick, ReadoutState } from '../../src/shared/aetherChoice/types';
import { newRecord, planLaunch } from '../../src/shared/aetherChoice/pickRecord';
import type { LaunchPlan, ThreadPickRecord } from '../../src/shared/aetherChoice/pickRecord';
import type { BudgetLevel } from '../../src/shared/aetherChoice/pickPolicy';
import { usageFromSnapshot } from '../../src/shared/aetherChoice/readback';
import type { TerminalSlotId, TerminalWritePort } from '../../src/shared/remote/types';
import type { StatuslineSnapshot } from '../../src/shared/statuslinePayload';

export type OwnedSlot = 'claude' | 'terminal2';

export type PickHostDeps = {
  slots?: readonly OwnedSlot[];
  writePort: TerminalWritePort;
  readScreen(slot: OwnedSlot): Promise<IdleReading>;
  loadRecords(): Record<string, ThreadPickRecord>;
  save(records: Record<string, ThreadPickRecord>): Promise<void>;
  initialPick: Pick;
  now(): number;
  schedule(fn: () => void, ms: number): () => void;
  log(line: string): void;
  notifyFailure(info: FailureInfo): void;
  quietMs?: number;
  readMaxAgeMs?: number;
  tickMs?: number;
  launchGraceMs?: number;
  readbackTimeoutMs?: number;
  minWriteGapMs?: number;
};

export type LaunchDecision =
  | { command: string }
  | { command: null; reason: 'halted' | 'not-launchable' | 'not-owned' };

export type SlotState = {
  readout: ReadoutState;
  tier: ModelAlias;
  effort: LaunchEffort;
  reason: string;
  auto: boolean;
  target?: { tier: ModelAlias; effort: LaunchEffort };
  haltedText?: string;
};

export type PickHost = {
  launchFor(slot: OwnedSlot, o?: { sessionId?: string; resume?: boolean }): LaunchDecision;
  onLaunched(slot: OwnedSlot): void;
  onSlotExit(slot: OwnedSlot): void;
  onForeignLaunch(slot: OwnedSlot): void;
  noteUserInput(slot: OwnedSlot): void;
  noteOutput(slot: OwnedSlot): void;
  onStatusline(snapshot: StatuslineSnapshot): void;
  submitPick(slot: OwnedSlot, pick: Pick, reason: string): { rejected: string | null };
  clearHalt(slot: OwnedSlot): void;
  state(slot: OwnedSlot): SlotState | null;
  flush(): Promise<void>;
  dispose(): void;
};

type StoredReading = { reading: IdleReading; startedAt: number; epoch: number };
type Stash = { plan: LaunchPlan; sessionId: string | null };
type LaunchInfo = { sessionId: string | null; sentAtMs: number };

export function createPickHost(deps: PickHostDeps): PickHost {
  const owned: readonly OwnedSlot[] = deps.slots ?? ['claude', 'terminal2'];
  const quietMs = deps.quietMs ?? 1500;
  const readMaxAgeMs = deps.readMaxAgeMs ?? 2000;
  const tickMs = deps.tickMs ?? 500;
  const launchGraceMs = deps.launchGraceMs ?? 10000;

  const records = new Map<string, ThreadPickRecord>(Object.entries(deps.loadRecords()));
  const epoch = new Map<OwnedSlot, number>();
  const readings = new Map<OwnedSlot, StoredReading>();
  const lastOutputAt = new Map<OwnedSlot, number>();
  const lastUserInputAt = new Map<OwnedSlot, number>();
  const launchAt = new Map<OwnedSlot, number>();
  const launch = new Map<OwnedSlot, LaunchInfo>();
  const budgetLevel = new Map<OwnedSlot, BudgetLevel>();
  const pending = new Map<OwnedSlot, Stash>();
  let snapshot: StatuslineSnapshot | null = null;
  let disposed = false;
  let cancelTick: (() => void) | null = null;
  let ticking = false;
  let dirty = false;
  let pump: Promise<void> | null = null;

  const isOwned = (slot: string): slot is OwnedSlot => (owned as readonly string[]).includes(slot);
  const epochOf = (slot: OwnedSlot): number => epoch.get(slot) ?? 0;
  const bump = (slot: OwnedSlot): void => {
    epoch.set(slot, epochOf(slot) + 1);
    readings.delete(slot);
  };
  const safeLog = (line: string): void => {
    try {
      deps.log(line);
    } catch {
      // a failing log sink must not break the host
    }
  };

  function usage(): { sessionPct: number; weekPct: number } {
    const u = usageFromSnapshot(snapshot, deps.now());
    return u.known ? { sessionPct: u.sessionPct, weekPct: u.weekPct } : { sessionPct: 0, weekPct: 0 };
  }

  // Quiet test shared by the idle gate and shell demotion. `startedAt` is when the read began.
  function settled(slot: OwnedSlot, startedAt: number): 'ok' | 'draft' | 'unknown' {
    const out = lastOutputAt.get(slot);
    if (out === undefined || startedAt - out < quietMs) return 'unknown';
    const user = lastUserInputAt.get(slot);
    if (user !== undefined && (startedAt - user < quietMs || deps.now() - user < quietMs)) return 'draft';
    return 'ok';
  }

  function idleFor(slot: OwnedSlot): IdleReading {
    const r = readings.get(slot);
    if (!r || r.epoch !== epochOf(slot) || deps.now() - r.startedAt > readMaxAgeMs) return 'unknown';
    if (r.reading !== 'idle') return r.reading;
    const s = settled(slot, r.startedAt);
    return s === 'ok' ? 'idle' : s;
  }

  async function runPump(): Promise<void> {
    while (dirty) {
      dirty = false;
      const snap = Object.fromEntries(records);
      try {
        await deps.save(snap);
      } catch {
        safeLog('save-failed');
      }
    }
    pump = null;
  }

  function requestSave(): void {
    dirty = true;
    if (!pump) pump = runPump();
  }

  const hasPendingQueue = (slot: OwnedSlot): boolean => {
    const rec = records.get(slot);
    return !!rec && rec.live && !rec.halted && rec.queue !== null;
  };

  function ensureTick(): void {
    // A running tick reschedules itself when it ends.
    if (disposed || ticking || cancelTick || !owned.some(hasPendingQueue)) return;
    cancelTick = deps.schedule(() => {
      cancelTick = null;
      void tick();
    }, tickMs);
  }

  async function tick(): Promise<void> {
    if (disposed || ticking) return;
    ticking = true;
    try {
      for (const slot of owned) {
        if (disposed) return;
        if (!hasPendingQueue(slot)) continue;
        const startedAt = deps.now();
        const startEpoch = epochOf(slot);
        let reading: IdleReading;
        try {
          reading = await deps.readScreen(slot);
        } catch {
          reading = 'unknown';
        }
        if (disposed || epochOf(slot) !== startEpoch) continue;
        readings.set(slot, { reading, startedAt, epoch: startEpoch });
        if (reading === 'shell' && settled(slot, startedAt) === 'ok' && deps.now() - (launchAt.get(slot) ?? 0) >= launchGraceMs) {
          engine.onExited(slot);
          bump(slot);
          continue;
        }
        engine.onIdleCheck(slot);
      }
    } finally {
      ticking = false;
    }
    ensureTick();
  }

  const engine = createApplyEngine({
    writePort: deps.writePort,
    slotFor: (id): TerminalSlotId | null => (isOwned(id) ? id : null),
    idle: (slot) => (isOwned(slot) ? idleFor(slot) : 'unknown'),
    now: deps.now,
    log: safeLog,
    notifyFailure: deps.notifyFailure,
    awayMode: () => false,
    usage,
    getRecord: (id) => records.get(id),
    setRecord: (id, rec) => {
      records.set(id, rec);
      requestSave();
      ensureTick();
    },
    minWriteGapMs: deps.minWriteGapMs,
    hasReadback: () => false,
  });

  for (const slot of owned) {
    if (!records.has(slot)) {
      records.set(slot, newRecord(slot, deps.initialPick, { reason: 'default', trigger: 'new-thread', source: 'auto' }));
    }
  }
  // Nothing is live at app start: normalize a persisted live or sent record before any tick.
  for (const slot of owned) engine.onExited(slot);

  function resetSlot(slot: OwnedSlot): void {
    engine.onExited(slot);
    bump(slot);
    launch.delete(slot);
    pending.delete(slot);
    budgetLevel.set(slot, 'none');
  }

  return {
    launchFor(slot, o) {
      if (!isOwned(slot)) return { command: null, reason: 'not-owned' };
      let rec = records.get(slot);
      if (!rec) return { command: null, reason: 'not-owned' };
      if (rec.live) {
        engine.onExited(slot);
        bump(slot);
        rec = records.get(slot) ?? rec;
      }
      const refuse = (reason: 'halted' | 'not-launchable'): LaunchDecision => {
        pending.delete(slot);
        safeLog(`launch-unmanaged ${slot} ${reason}`);
        return { command: null, reason };
      };
      const plan = planLaunch(rec, usage());
      if ('error' in plan) return refuse(plan.error === 'halted' ? 'halted' : 'not-launchable');
      const resume = o?.resume === true;
      let command: string;
      try {
        command = buildAetherLaunchCommand({ model: plan.model, effort: plan.effort, sessionId: o?.sessionId, resume });
      } catch {
        return refuse('not-launchable');
      }
      pending.set(slot, { plan: { ...plan, resume }, sessionId: o?.sessionId ?? null });
      return { command };
    },

    onLaunched(slot) {
      if (disposed || !isOwned(slot)) return;
      const stash = pending.get(slot);
      const rec = records.get(slot);
      if (!stash || !rec || rec.halted) {
        pending.delete(slot);
        safeLog(`launched-without-plan ${slot}`);
        return;
      }
      pending.delete(slot);
      bump(slot);
      const t = deps.now();
      launchAt.set(slot, t);
      launch.set(slot, { sessionId: stash.sessionId, sentAtMs: t });
      engine.onLaunched(slot, stash.plan);
      budgetLevel.set(slot, stash.plan.budgetLevel);
    },

    onSlotExit(slot) {
      if (disposed || !isOwned(slot)) return;
      resetSlot(slot);
    },

    onForeignLaunch(slot) {
      if (disposed || !isOwned(slot)) return;
      resetSlot(slot);
    },

    noteUserInput(slot) {
      if (isOwned(slot)) lastUserInputAt.set(slot, deps.now());
    },

    noteOutput(slot) {
      if (isOwned(slot)) lastOutputAt.set(slot, deps.now());
    },

    onStatusline(s) {
      snapshot = s;
    },

    submitPick(slot, pick, reason) {
      if (
        disposed ||
        !isOwned(slot) ||
        !(MODEL_ALIASES as readonly string[]).includes(pick.model) ||
        !(LAUNCH_EFFORTS as readonly string[]).includes(pick.effort)
      ) {
        return { rejected: 'invalid pick' };
      }
      const r = engine.onPick(slot, pick, { reason, trigger: 'manual', source: 'manual' });
      ensureTick();
      return r;
    },

    clearHalt(slot) {
      if (!disposed && isOwned(slot)) engine.clearHalt(slot);
    },

    state(slot) {
      if (!isOwned(slot)) return null;
      const rec = records.get(slot);
      if (!rec) return null;
      const running = rec.launched ?? rec.intended;
      const out: SlotState = {
        readout: engine.readoutState(slot) ?? 'steady',
        tier: running.model,
        effort: running.effort,
        reason: rec.reason,
        auto: rec.source === 'auto',
      };
      if (rec.queue) out.target = { tier: rec.queue.pick.model, effort: rec.queue.pick.effort };
      else if (rec.modelPending) out.target = { tier: rec.modelPending, effort: rec.intended.effort };
      if (rec.halted) {
        const w = rec.halted.wanted;
        const a = rec.halted.actual;
        out.haltedText = `wanted ${w.model}/${w.effort}, running ${a ? `${a.model}/${a.effort}` : 'unknown'}`;
      }
      return out;
    },

    async flush() {
      while (pump) await pump;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (cancelTick) cancelTick();
      cancelTick = null;
      for (const slot of owned) bump(slot);
    },
  };
}
