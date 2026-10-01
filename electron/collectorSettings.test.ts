import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COLLECTOR_SETTINGS_FILE,
  collectorSettingsPath,
  readMemoryExtractionEnabled,
  writeMemoryExtractionEnabled,
} from './collectorSettings';
// The collector's reader is the consumer of this file. Importing it here (test
// only) is what proves the two twins agree on path and key.
import {
  COLLECTOR_SETTINGS_FILE as COLLECTOR_FILE,
  readMemoryExtractionEnabled as collectorRead,
} from '../collector/src/collectorSettings';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aether-collset-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('collectorSettings (electron writer)', () => {
  it('uses the same file name as the collector reader', () => {
    expect(COLLECTOR_SETTINGS_FILE).toBe(COLLECTOR_FILE);
  });

  it('a value written through the Electron writer is what the collector reader obeys', () => {
    const path = join(dir, COLLECTOR_FILE);
    expect(collectorRead(path)).toBe(false);
    expect(writeMemoryExtractionEnabled(dir, true, 5)).toBe(true);
    expect(collectorSettingsPath(dir)).toBe(path);
    expect(collectorRead(path)).toBe(true);
    expect(writeMemoryExtractionEnabled(dir, false, 6)).toBe(false);
    expect(collectorRead(path)).toBe(false);
  });

  it('writes the documented shape and leaves no tmp file behind', () => {
    writeMemoryExtractionEnabled(dir, true, 42);
    expect(JSON.parse(readFileSync(collectorSettingsPath(dir), 'utf8'))).toEqual({
      memoryExtractionEnabled: true,
      updatedAtMs: 42,
    });
    expect(readdirSync(dir)).toEqual([COLLECTOR_SETTINGS_FILE]);
  });

  it('reads the cross-twin literal as true and rejects loose values', () => {
    const p = join(dir, 'x.json');
    writeFileSync(p, '{"memoryExtractionEnabled":true,"updatedAtMs":1}');
    expect(readMemoryExtractionEnabled(p)).toBe(true);
    for (const bad of ['{"memoryExtractionEnabled":"true"}', '{"memoryExtractionEnabled":1}', '{}', '[]', 'null', '{oops']) {
      writeFileSync(p, bad);
      expect(readMemoryExtractionEnabled(p)).toBe(false);
    }
    expect(readMemoryExtractionEnabled(join(dir, 'missing.json'))).toBe(false);
  });

  it('returns the readback, not the request, when the write fails', () => {
    // aetherDir is a regular FILE, so mkdir/write beneath it throws.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory');
    expect(writeMemoryExtractionEnabled(blocker, true, 1)).toBe(false);
  });
});

describe('collectorSettings rename-stage failure', () => {
  it('returns the readback and leaves no tmp file when the rename fails', () => {
    // The target is a DIRECTORY, so tmp-then-rename throws after the tmp write succeeded.
    mkdirSync(collectorSettingsPath(dir));
    expect(writeMemoryExtractionEnabled(dir, true, 1)).toBe(false);
    expect(readdirSync(dir)).toEqual([COLLECTOR_SETTINGS_FILE]);
  });
});
