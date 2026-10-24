import { mkdirSync, writeFileSync, renameSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { uniqueSiblingPath } from './atomicWrite';

// Owner of ~/.aether-os/control-settings.json: {"v":1,"reenableAtLaunch":boolean} and nothing else. It holds the
// phone-control opt-in "turn the listener back on at launch" flag (privacy section 17). main.ts reads and writes it
// only after the user-only ACL on ~/.aether-os has been applied.
export const CONTROL_SETTINGS_FILE = 'control-settings.json';

export function controlSettingsPath(aetherDir: string): string {
  return join(aetherDir, CONTROL_SETTINGS_FILE);
}

/** True ONLY when the file parses to a non-array object whose reenableAtLaunch === true. Never throws; fails closed. */
export function readReenable(filePath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    return (parsed as Record<string, unknown>).reenableAtLaunch === true;
  } catch {
    return false;
  }
}

/**
 * Atomic tmp-then-rename write, then returns the READBACK from disk, never the requested value: a failed write
 * shows whatever the file still says. Never throws.
 */
export function writeReenable(aetherDir: string, on: boolean, log?: (line: string) => void): boolean {
  const targetPath = controlSettingsPath(aetherDir);
  const tmpPath = uniqueSiblingPath(targetPath, 'aethertmp');
  try {
    mkdirSync(aetherDir, { recursive: true });
    writeFileSync(tmpPath, JSON.stringify({ v: 1, reenableAtLaunch: on }), 'utf8');
    renameSync(tmpPath, targetPath);
  } catch {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best effort
    }
  }
  return readReenable(targetPath);
}
