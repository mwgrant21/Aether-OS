import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyGuidanceToFile } from './guidanceWriter';

// This test exists to pin the exact result shape main.ts's optimize:apply
// handler destructures, so a future edit to applyGuidanceToFile's return type
// is caught here before it silently breaks the wiring. Same purpose as
// main.narration.test.ts.
describe('main.ts optimize:apply wiring shape', () => {
  it('an added result carries ok, added and a backupPath the handler can pass through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-optimize-wiring-'));
    const target = join(dir, 'CLAUDE.md');
    writeFileSync(target, '# g\n', 'utf8');

    const result = await applyGuidanceToFile(target, 'opus-on-trivial-turns');
    expect(result.ok).toBe(true);
    if (!result.ok || !result.added) throw new Error('expected an added result');
    // main.ts reads exactly these two fields off the success branch.
    expect(result.added).toBe(true);
    expect(typeof result.backupPath === 'string' || result.backupPath === null).toBe(true);
  });

  it('a failure result carries an error string the handler can return verbatim', async () => {
    const dirAsFile = mkdtempSync(join(tmpdir(), 'aether-optimize-wiring-dir-'));
    const result = await applyGuidanceToFile(dirAsFile, 'opus-on-trivial-turns');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(typeof result.error).toBe('string');
  });
});
