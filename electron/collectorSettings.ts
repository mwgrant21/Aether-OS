import { mkdirSync, writeFileSync, renameSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { uniqueSiblingPath } from './atomicWrite';

// Electron-side owner of ~/.aether-os/collector-settings.json (issue #104).
// The collector process reads this file to decide whether memory extraction
// (a `claude -p` model call) may run. Same no-cross-import precedent as
// ownSessionFile.ts: collector/src/collectorSettings.ts is the DUPLICATED reader
// twin, and the file name and key below MUST match it (a test pins both).
export const COLLECTOR_SETTINGS_FILE = 'collector-settings.json';

export function collectorSettingsPath(aetherDir: string): string {
  return join(aetherDir, COLLECTOR_SETTINGS_FILE);
}

/**
 * Twin of collector/src/collectorSettings.ts#readMemoryExtractionEnabled:
 * true ONLY when the file parses to a non-null, non-array object whose
 * memoryExtractionEnabled === true. Never throws; fails closed.
 */
export function readMemoryExtractionEnabled(filePath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    return (parsed as Record<string, unknown>).memoryExtractionEnabled === true;
  } catch {
    return false;
  }
}

/**
 * Atomic tmp-then-rename write, then returns the READBACK from disk, never the
 * requested value: a failed write must show as OFF (or as whatever the file
 * still says), not as the user's wish. Never throws.
 */
export function writeMemoryExtractionEnabled(aetherDir: string, enabled: boolean, nowMs: number): boolean {
  const targetPath = collectorSettingsPath(aetherDir);
  const tmpPath = uniqueSiblingPath(targetPath, 'aethertmp');
  try {
    mkdirSync(aetherDir, { recursive: true });
    writeFileSync(tmpPath, JSON.stringify({ memoryExtractionEnabled: enabled, updatedAtMs: nowMs }), 'utf8');
    renameSync(tmpPath, targetPath);
  } catch {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best effort
    }
  }
  return readMemoryExtractionEnabled(targetPath);
}
