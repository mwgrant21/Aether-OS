// Read-only Memory feed for the generic phone view channel. It reads the memory DB through `read` on each attach and on
// each notify() (called from scanAndPushMemory), runs the fail-closed encoder (free text masked and capped; reference
// counts and extraction cost never sent), and fans the validated payload out to attached taps. It holds nothing between
// deliveries but the list of taps. An unreadable DB (read returns null), a throwing read or encoder, or a throwing tap
// neither stops the other taps nor escapes attach()/notify(); the first two yield d:null. Nothing is logged.
import type { MemoryRowUI, MemoryTombstoneUI } from './memoryStore';
import type { ViewReadPort, ViewTap } from '../src/shared/remote/types';
import { encodeMemoryView } from './control/viewWire';

export interface MemoryFeedDeps {
  read: () => { live: MemoryRowUI[] | null; tombstones: MemoryTombstoneUI[] | null };
  now?: () => number;
}

function payload(d: MemoryFeedDeps): Record<string, unknown> | null {
  try {
    const { live, tombstones } = d.read();
    if (!live || !tombstones) return null;
    return encodeMemoryView({ computedAtMs: (d.now ?? Date.now)(), live, tombstones });
  } catch {
    return null; // fail closed: "no data", never a partial payload
  }
}

export function createMemoryFeed(deps: MemoryFeedDeps): { port: ViewReadPort; notify(): void } {
  const taps = new Set<ViewTap>();

  const deliver = (tap: ViewTap, d: Record<string, unknown> | null): void => {
    try {
      tap.snap(d);
    } catch {
      // a failing tap must not break the other taps or the caller
    }
  };

  const port: ViewReadPort = {
    attach(tap) {
      taps.add(tap);
      deliver(tap, payload(deps));
      return {
        detach: () => {
          taps.delete(tap);
        },
      };
    },
  };

  const notify = (): void => {
    if (taps.size === 0) return;
    const d = payload(deps);
    for (const tap of [...taps]) deliver(tap, d);
  };

  return { port, notify };
}
