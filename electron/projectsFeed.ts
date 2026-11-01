// Read-only Projects feed for the generic phone view channel. It maps main's two cached snapshots (projects and the
// global ledger) onto the narrow ProjectsWire (derived numbers and basenames only: no paths, no optimize findings, no
// timeZone), runs the fail-closed encoder, and fans the validated payload out to attached taps. It holds no copy:
// every delivery re-reads current(), so the only retention is main's existing caches. A throwing encoder or tap
// neither stops the other taps nor escapes attach()/notify(). Nothing is logged.
import type { LedgerSnapshot } from '../src/shared/ledgerMath';
import type { ProjectsSnapshot } from '../src/shared/projectsSnapshot';
import type { LedgerWire, ProjectsWire, ViewReadPort, ViewTap } from '../src/shared/remote/types';
import { encodeProjectsView } from './control/viewWire';

export interface ProjectsFeedDeps {
  current: () => { projects: ProjectsSnapshot | null; ledger: LedgerSnapshot | null };
}

function ledgerWire(s: LedgerSnapshot): LedgerWire {
  return {
    computedAtMs: s.computedAtMs,
    total: { usd: s.total.usd, input: s.total.breakdown.input, output: s.total.breakdown.output, cacheCreation: s.total.breakdown.cacheCreation, cacheRead: s.total.breakdown.cacheRead },
    tiers: [...s.tiers],
    rollups: { today: s.rollups.today, week: s.rollups.week, month: s.rollups.month },
    cache: { readTokens: s.cache.cacheReadTokens, wouldHaveUsd: s.cache.wouldHaveCostUsd, actualUsd: s.cache.actuallyCostUsd, savedUsd: s.cache.savedUsd, hitRate: s.cacheHitRate },
  };
}

function payload(d: ProjectsFeedDeps): Record<string, unknown> | null {
  try {
    const { projects, ledger } = d.current();
    if (!projects || !ledger) return null;
    const wire: ProjectsWire = {
      computedAtMs: projects.computedAtMs,
      all: ledgerWire(ledger),
      unscoped: projects.unscoped ? ledgerWire(projects.unscoped) : null,
      roots: projects.roots.map((r) => ({
        key: r.key,
        name: r.name,
        ledger: ledgerWire(r.ledger),
        children: r.children.map((c) => ({ key: c.key, worktree: c.worktree, ledger: ledgerWire(c.ledger) })),
      })),
    };
    return encodeProjectsView(wire);
  } catch {
    return null; // fail closed: "no data", never a partial payload
  }
}

export function createProjectsFeed(deps: ProjectsFeedDeps): { port: ViewReadPort; notify(): void } {
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
