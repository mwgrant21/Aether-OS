import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ownSessionFilePath, writeOwnSessionFile, readOwnSessionId } from './ownSessionFile';

function tempFileWith(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-ownsession-'));
  const filePath = ownSessionFilePath(dir);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

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

describe('readOwnSessionId', () => {
  it('returns the sessionId from a well-formed file', () => {
    const filePath = tempFileWith(JSON.stringify({ sessionId: 'sess-abc', updatedAtMs: 1000 }));
    expect(readOwnSessionId(filePath)).toBe('sess-abc');
  });

  it('returns null when sessionId is explicitly null (no pty currently pinned)', () => {
    const filePath = tempFileWith(JSON.stringify({ sessionId: null, updatedAtMs: 1000 }));
    expect(readOwnSessionId(filePath)).toBeNull();
  });

  it('returns null when the file does not exist', () => {
    const missingPath = join(tmpdir(), 'aether-ownsession-missing-' + Date.now(), 'own-session.json');
    expect(readOwnSessionId(missingPath)).toBeNull();
  });

  it('returns null for malformed JSON, never throws', () => {
    const filePath = tempFileWith('not json{{');
    expect(() => readOwnSessionId(filePath)).not.toThrow();
    expect(readOwnSessionId(filePath)).toBeNull();
  });

  it('returns null when sessionId is missing or not a string', () => {
    expect(readOwnSessionId(tempFileWith(JSON.stringify({ updatedAtMs: 1000 })))).toBeNull();
    expect(readOwnSessionId(tempFileWith(JSON.stringify({ sessionId: 42 })))).toBeNull();
  });
});
