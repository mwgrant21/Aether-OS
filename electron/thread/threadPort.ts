// ThreadReadPort over per-slot transcript feeds (V3-A3 T4, spec 4.1). One feed per thread slot, created inert:
// a feed reads nothing and holds no timer until a phone attaches, and frees everything on the last detach.
// electron/control consumes this through the ThreadReadPort interface only.
import {
  THREAD_SLOTS,
  type ThreadAttachment,
  type ThreadDetail,
  type ThreadReadPort,
  type ThreadSlotId,
  type ThreadTap,
} from '../../src/shared/remote/threadTypes';
import { createThreadFeed, type ThreadFeed } from './threadFeed';

export interface ThreadPortDeps {
  /** Slot to its Claude session and transcript file; null when the slot has no known session. */
  resolve: (slot: ThreadSlotId) => { sessionId: string; file: string } | null;
  /** Last statusline context percentage for the slot; null when none is known (Terminal 2 never has one). */
  statuslineCtx?: (slot: ThreadSlotId) => { pct: number } | null;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (h: any) => void;
  log?: (line: string) => void;
  pollMs?: number;
  seedBytes?: number;
  maxReadBytes?: number;
}

export interface ThreadPort extends ThreadReadPort {
  /** Test hook: one poll of the slot's feed. */
  tick(slot: ThreadSlotId): Promise<void>;
}

export function createThreadPort(deps: ThreadPortDeps): ThreadPort {
  const feeds = new Map<ThreadSlotId, ThreadFeed>();
  for (const slot of THREAD_SLOTS) {
    feeds.set(
      slot,
      createThreadFeed({
        slot,
        resolve: () => deps.resolve(slot),
        statuslineCtx: deps.statuslineCtx ? () => deps.statuslineCtx!(slot) : undefined,
        now: deps.now,
        setIntervalFn: deps.setIntervalFn,
        clearIntervalFn: deps.clearIntervalFn,
        log: deps.log,
        pollMs: deps.pollMs,
        seedBytes: deps.seedBytes,
        maxReadBytes: deps.maxReadBytes,
      }),
    );
  }
  const feedOf = (slot: string): ThreadFeed | undefined => feeds.get(slot as ThreadSlotId);

  return {
    attach(slot: ThreadSlotId, tap: ThreadTap): ThreadAttachment {
      const f = feedOf(slot);
      return f ? f.attach(tap) : { detach() {} };
    },
    detail(slot: ThreadSlotId, id: string): ThreadDetail | null {
      return feedOf(slot)?.detail(id) ?? null;
    },
    noteNotification(sessionId: string, type: string): void {
      for (const f of feeds.values()) f.noteNotification(sessionId, type);
    },
    stopAll(): void {
      for (const f of feeds.values()) f.stop();
    },
    tick(slot: ThreadSlotId): Promise<void> {
      return feedOf(slot)?.tick() ?? Promise.resolve();
    },
  };
}
