import { describe, it, expect } from 'vitest';
import { createScopedGitProbe } from './gitProbeCache';

describe('createScopedGitProbe', () => {
  it('memoises within a single scan cycle', () => {
    let calls = 0;
    const { probe } = createScopedGitProbe((dir) => {
      calls++;
      return dir === '/repo';
    });
    expect(probe('/repo')).toBe(true);
    expect(probe('/repo')).toBe(true);
    expect(calls).toBe(1);
  });

  it('detects a directory that becomes a repo between scan cycles instead of sticking on a stale false', () => {
    let isRepo = false;
    const { probe, reset } = createScopedGitProbe(() => isRepo);

    // Cycle 1: not yet a repo, cached as false for this cycle.
    expect(probe('/dir')).toBe(false);

    // The directory becomes a git repo between scan cycles.
    isRepo = true;

    // Same cycle: stale cached false must still stick.
    expect(probe('/dir')).toBe(false);

    // New scan cycle: reset() clears the cache, so the next probe re-checks.
    reset();
    expect(probe('/dir')).toBe(true);
  });
});
