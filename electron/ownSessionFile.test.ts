import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ownSessionFilePath, writeOwnSessionFile } from './ownSessionFile';

describe('writeOwnSessionFile', () => {
  it('writes a JSON file with sessionId and updatedAtMs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-ownsession-'));
    writeOwnSessionFile(dir, 'sess-abc', 5000);
    const content = JSON.parse(readFileSync(ownSessionFilePath(dir), 'utf8'));
    expect(content).toEqual({ sessionId: 'sess-abc', updatedAtMs: 5000 });
  });

  it('writes sessionId: null when nothing is pinned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-ownsession-'));
    writeOwnSessionFile(dir, null, 1000);
    const content = JSON.parse(readFileSync(ownSessionFilePath(dir), 'utf8'));
    expect(content.sessionId).toBeNull();
  });

  it('creates the target directory if it does not exist yet', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'aether-ownsession-')), 'nested', '.aether-os');
    expect(existsSync(dir)).toBe(false);
    writeOwnSessionFile(dir, 'sess-1', 1000);
    expect(existsSync(ownSessionFilePath(dir))).toBe(true);
  });

  it('does not leave a stray .tmp file behind after a successful write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-ownsession-'));
    writeOwnSessionFile(dir, 'sess-1', 1000);
    expect(existsSync(`${ownSessionFilePath(dir)}.tmp`)).toBe(false);
  });

  it('never throws even if writing fails (e.g. a file exists where a directory is expected)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-ownsession-'));
    const blockerPath = join(dir, 'blocked');
    require('fs').writeFileSync(blockerPath, 'i am a file, not a directory');
    expect(() => writeOwnSessionFile(join(blockerPath, 'nested'), 'sess-1', 1000)).not.toThrow();
  });
});
