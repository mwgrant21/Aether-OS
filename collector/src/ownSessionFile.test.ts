import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readOwnSessionId } from './ownSessionFile.js';

function tempFileWith(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-ownsession-'));
  const filePath = join(dir, 'own-session.json');
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

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
    const missingPath = join(tmpdir(), 'aether-collector-ownsession-missing-' + Date.now(), 'own-session.json');
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
