import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMemoryExtractionEnabled, COLLECTOR_SETTINGS_FILE } from './collectorSettings.js';

describe('readMemoryExtractionEnabled', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aether-collector-settings-'));
    file = join(dir, COLLECTOR_SETTINGS_FILE);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('uses the contract file name', () => {
    expect(COLLECTOR_SETTINGS_FILE).toBe('collector-settings.json');
  });

  it('is false when the file is missing', () => {
    expect(readMemoryExtractionEnabled(file)).toBe(false);
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['an array', '[]'],
    ['null', 'null'],
    ['the string "true"', '{"memoryExtractionEnabled":"true"}'],
    ['the number 1', '{"memoryExtractionEnabled":1}'],
    ['an empty object', '{}'],
    ['explicit false', '{"memoryExtractionEnabled":false}'],
  ])('is false for %s', (_label, body) => {
    writeFileSync(file, body, 'utf8');
    expect(readMemoryExtractionEnabled(file)).toBe(false);
  });

  it('is true only for the strict boolean (cross-twin contract literal)', () => {
    writeFileSync(file, '{"memoryExtractionEnabled":true,"updatedAtMs":1}', 'utf8');
    expect(readMemoryExtractionEnabled(file)).toBe(true);
  });
});
