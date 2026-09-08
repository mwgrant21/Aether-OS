// One turn's state, owned by the adapter rather than by a `sendTurn` closure.
//
// WHY THIS EXISTS. Seven Codex review rounds on PR #47 found seven defects in
// the app-server turn handling, and rounds 4-7 were each a hazard introduced by
// the previous round's fix:
//
//   3 -> `activeTurn.set(acceptedId)` gave cancel() an id ...
//   4 -> ... which a stale notification could then overwrite ...
//   5 -> ... so the id came only from turn/start, leaving a pre-ack window ...
//   6 -> ... closed by replaying the interrupt, which never ran if the ack
//        itself missed the deadline ...
//   7 -> ... closed by a late-response handler, which was retained forever.
//
// Every one of those fixes was locally correct. The sequence still did not
// converge, because they all shared a wrong premise: that `sendTurn` owns the
// turn. It does not. **The provider-side turn outlives `sendTurn`** -- when
// `sendTurn` returns on a deadline, the turn is often still running on the
// server, and the things that still matter about it (its accepted id, whether
// a cancellation is outstanding, whether a late acknowledgement should trigger
// an interrupt) have no owner. Each fix was another attempt to smuggle that
// state out of a closure that had already ended: a flag, then a map, then a
// callback, then a bounded map of callbacks.
//
// A TurnRecord is that owner. It is created before the turn is sent, lives as
// long as the provider-side turn might, and is retired through exactly one
// function. `sendTurn` becomes a consumer of a record, not its lifetime.

import { EMPTY_USAGE, type ProviderEvent, type TurnUsage } from './contract';

/** Minimal shape of the generated `Turn` this adapter reads. */
export type TurnLike = { id?: unknown; status?: unknown; error?: unknown };

/** The fields every turn-scoped notification carries. `turnId` is what makes a
 *  late notification from a previous turn distinguishable from this turn's. */
export interface TurnScopedParams {
  threadId?: string;
  turnId?: string;
  delta?: string;
  tokenUsage?: unknown;
}

/** How a turn stopped waiting. A dead transport is NOT a deadline: the
 *  contract requires transport faults to throw rather than return a stop
 *  reason, so collapsing both into "no turn arrived" would hide a crashed
 *  provider behind `stopReason: 'timeout'`. */
export type WaiterResult = { kind: 'turn'; turn: TurnLike | null } | { kind: 'gone'; reason: string };

export type TurnPhase = 'awaiting-ack' | 'running' | 'retired';

/** TurnStatus is "completed" | "interrupted" | "failed" | "inProgress". Only
 *  the first three are outcomes; "inProgress" means the answer has not arrived
 *  yet, which is what `turn/start` normally returns. */
export function isTerminalTurnStatus(status: unknown): boolean {
  return status === 'completed' || status === 'interrupted' || status === 'failed';
}

export class TurnRecord {
  /** Server-assigned id, once `turn/start` is acknowledged. Null until then --
   *  and that null window is real, which is what rounds 5 and 6 were about. */
  turnId: string | null = null;
  phase: TurnPhase = 'awaiting-ack';
  cancelRequested = false;
  text = '';
  usage: TurnUsage = EMPTY_USAGE;

  /** Approvals refused during this turn, replayed to the caller as events once
   *  the turn resolves. */
  readonly approvalDenials: Array<{ method: string; id: string }> = [];

  /** `turn/completed` that arrived before `turn/start`'s response told us the
   *  accepted id. Normal: the server may answer the notification first. */
  readonly earlyCompletions = new Map<string, TurnLike | null>();

  /** Turn-scoped content that arrived before the accepted id was known.
   *  Buffered rather than dropped -- these are very likely this turn's own
   *  opening deltas -- and filtered on flush by the id we eventually learn. */
  readonly buffered: Array<{ method: string; params: TurnScopedParams }> = [];

  /** True while a `sendTurn` call is still awaiting this turn's outcome.
   *  The TTL sweep must never touch such a record: the TTL (2 min) is SHORTER
   *  than the default turn deadline (5 min), so expiring on age alone would
   *  pull the record out from under a caller that is still legitimately
   *  waiting, and its later deltas and completion would then find nothing --
   *  reporting a successful long turn as a truncated timeout. */
  callerWaiting = true;

  /** Autonomous expiry for a record the caller has stopped waiting on.
   *  Checking `expiresAt` only when another turn happens to start is not a
   *  TTL: if no later turn is submitted, the record simply never expires. */
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  private settleFn: ((r: WaiterResult) => void) | null = null;
  private settled = false;

  /** Resolves when the turn reaches an outcome, the transport dies, or the
   *  adapter is disposed. Deliberately NOT tied to the caller's deadline: the
   *  deadline belongs to `sendTurn`, the outcome belongs to the record. */
  readonly outcome: Promise<WaiterResult>;

  constructor(
    readonly sessionId: string,
    /** `turn/start`'s request id -- the turn's identity before the server
     *  names it, and the key a late response is matched on. */
    readonly requestId: number,
    readonly listener: (e: ProviderEvent) => void,
    /** Absolute time after which this record is swept even if nothing ever
     *  arrives, so an unacknowledged turn cannot retain it forever. */
    public expiresAt: number
  ) {
    this.outcome = new Promise<WaiterResult>((resolve) => {
      this.settleFn = resolve;
    });
  }

  settle(result: WaiterResult): void {
    if (this.settled) return;
    this.settled = true;
    this.settleFn?.(result);
  }

  get isSettled(): boolean {
    return this.settled;
  }

  /** True once nothing further can usefully happen to this turn. A record
   *  whose id is still unknown is NOT done: its late acknowledgement may still
   *  need to carry out a cancellation. */
  get isDone(): boolean {
    return this.phase === 'retired';
  }

/** The caller has stopped waiting, so this record now lives on its own clock.
   *
   *  ONE operation, because the three steps are only correct together and were
   *  previously written apart. `expiresAt` is set when the record is CREATED,
   *  but the caller may wait far longer than the TTL before giving up -- with
   *  the shipped defaults, 300s against a 120s TTL. Arming an expiry from that
   *  stale absolute time computed `max(0, 120s - 300s) = 0`, so the record was
   *  retired on the very next tick and the retention window it exists to
   *  provide was ZERO in the default configuration. Refreshing `expiresAt`
   *  here is the fix, and folding it in with `callerWaiting` and the timer is
   *  what stops the three drifting apart again.
   *
   *  `unref` so a retained record can never keep a plain Node process alive --
   *  the same hazard the dangling deadline timer had. */
  beginRetention(ttlMs: number, onExpire: () => void): void {
    this.callerWaiting = false;
    this.expiresAt = Date.now() + ttlMs;
    this.clearExpiry();
    this.expiryTimer = setTimeout(onExpire, Math.max(0, this.expiresAt - Date.now()));
    (this.expiryTimer as { unref?: () => void }).unref?.();
  }

  private clearExpiry(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  retire(): void {
    this.phase = 'retired';
    this.clearExpiry();
    this.earlyCompletions.clear();
    this.buffered.length = 0;
  }
}
