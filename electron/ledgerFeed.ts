// Read-only Ledger feed for the phone control channel. It maps main's cached LedgerSnapshot onto the narrow wire
// shape (numbers only; timeZone is not forwarded) and fans it out to attached taps. It holds no copy of the snapshot:
// every delivery re-reads current(), so the only retention is main's existing cache. Taps are isolated from each
// other: a throwing tap neither stops the others nor escapes attach()/notify(). Nothing is logged.
import type { LedgerSnapshot } from '../src/shared/ledgerMath';
import type { LedgerReadPort, LedgerTap, LedgerWire } from '../src/shared/remote/types';

export interface LedgerFeedDeps {
  current: () => LedgerSnapshot | null;
}

function toWire(s: LedgerSnapshot | null): LedgerWire | null {
  if (!s) return null;
  return {
    computedAtMs: s.computedAtMs,
    total: {
      usd: s.total.usd,
      input: s.total.breakdown.input,
      output: s.total.breakdown.output,
      cacheCreation: s.total.breakdown.cacheCreation,
      cacheRead: s.total.breakdown.cacheRead,
    },
    tiers: [...s.tiers],
    rollups: { today: s.rollups.today, week: s.rollups.week, month: s.rollups.month },
    cache: {
      readTokens: s.cache.cacheReadTokens,
      wouldHaveUsd: s.cache.wouldHaveCostUsd,
      actualUsd: s.cache.actuallyCostUsd,
      savedUsd: s.cache.savedUsd,
      hitRate: s.cacheHitRate,
    },
  };
}

export function createLedgerFeed(deps: LedgerFeedDeps): { port: LedgerReadPort; notify(): void } {
  const taps = new Set<LedgerTap>();

  const deliver = (tap: LedgerTap, wire: LedgerWire | null): void => {
    try {
      tap.snap(wire);
    } catch {
      // a failing tap must not break the other taps or the caller
    }
  };

  const port: LedgerReadPort = {
    attach(tap) {
      taps.add(tap);
      deliver(tap, toWire(deps.current()));
      return {
        detach: () => {
          taps.delete(tap);
        },
      };
    },
  };

  const notify = (): void => {
    const wire = toWire(deps.current());
    for (const tap of [...taps]) deliver(tap, wire);
  };

  return { port, notify };
}
