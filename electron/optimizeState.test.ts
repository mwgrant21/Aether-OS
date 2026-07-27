import { describe, it, expect } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sanitizeState, loadOptimizeState, recordAppliedAt } from './optimizeState';

async function tempStatePath(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aether-optimize-state-'));
  return path.join(dir, 'optimize-state.json');
}

describe('optimizeState', () => {
  it('sanitizeState keeps only finite-number entries', () => {
    expect(sanitizeState({ a: 123, b: 'nope', c: NaN, d: null, e: 456 })).toEqual({ a: 123, e: 456 });
    expect(sanitizeState(null)).toEqual({});
    expect(sanitizeState(undefined)).toEqual({});
    expect(sanitizeState('not an object')).toEqual({});
  });

  it('loadOptimizeState on a missing file -> {}', async () => {
    const statePath = await tempStatePath();
    expect(await loadOptimizeState(statePath)).toEqual({});
  });

  it('loadOptimizeState on invalid JSON -> {} (must not throw)', async () => {
    const statePath = await tempStatePath();
    await fsp.writeFile(statePath, 'not json{{', 'utf8');
    expect(await loadOptimizeState(statePath)).toEqual({});
  });

  it('recordAppliedAt writes a fresh timestamp and loadOptimizeState reads it back', async () => {
    const statePath = await tempStatePath();
    await recordAppliedAt(statePath, 'opus-on-trivial-turns', 1000);
    expect(await loadOptimizeState(statePath)).toEqual({ 'opus-on-trivial-turns': 1000 });
  });

  it('recordAppliedAt merges with existing entries rather than clobbering them', async () => {
    const statePath = await tempStatePath();
    await recordAppliedAt(statePath, 'opus-on-trivial-turns', 1000);
    await recordAppliedAt(statePath, 'unpinned-config-re-reads', 2000);
    expect(await loadOptimizeState(statePath)).toEqual({
      'opus-on-trivial-turns': 1000,
      'unpinned-config-re-reads': 2000,
    });
  });

  it('recordAppliedAt on the same id overwrites (reapply resets the clock)', async () => {
    const statePath = await tempStatePath();
    await recordAppliedAt(statePath, 'opus-on-trivial-turns', 1000);
    await recordAppliedAt(statePath, 'opus-on-trivial-turns', 5000);
    expect(await loadOptimizeState(statePath)).toEqual({ 'opus-on-trivial-turns': 5000 });
  });
});
