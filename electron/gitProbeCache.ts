// electron/gitProbeCache.ts
import type { GitProbe } from '../src/shared/projectIdentity';

/**
 * A memoising wrapper around a raw filesystem probe (e.g. `existsSync(join(dir,
 * '.git'))`). The cache is exposed via `reset()` rather than being scoped to the
 * process lifetime, so callers can clear it at the start of each scan cycle --
 * a directory that becomes a git repo between scans is then correctly detected
 * as scoped on the next scan, instead of a stale `false` sticking forever.
 * Within a single cycle (between resets) repeated probes of the same directory
 * still only touch the filesystem once.
 */
export function createScopedGitProbe(rawProbe: (dir: string) => boolean): {
  probe: GitProbe;
  reset: () => void;
} {
  let cache = new Map<string, boolean>();
  const probe: GitProbe = (dir) => {
    const cached = cache.get(dir);
    if (cached !== undefined) return cached;
    const exists = rawProbe(dir);
    cache.set(dir, exists);
    return exists;
  };
  const reset = () => {
    cache = new Map<string, boolean>();
  };
  return { probe, reset };
}
