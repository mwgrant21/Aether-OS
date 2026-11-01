import { mkdirSync, writeFileSync, renameSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { uniqueSiblingPath } from './atomicWrite';

// Owner of ~/.aether-os/control-settings.json: {"v":1,"reenableAtLaunch":boolean,"phoneTyping":boolean} and nothing
// else. reenableAtLaunch is the phone-control opt-in "turn the listener back on at launch" flag (privacy section 17);
// phoneTyping is the "phone may type" switch. main.ts reads and writes it only after the user-only ACL on
// ~/.aether-os has been applied. Every write rewrites BOTH fields (read, merge the patch, write), so neither write
// path can reset the other flag.
export const CONTROL_SETTINGS_FILE = 'control-settings.json';

export interface ControlSettings {
  reenableAtLaunch: boolean;
  phoneTyping: boolean;
}

export function controlSettingsPath(aetherDir: string): string {
  return join(aetherDir, CONTROL_SETTINGS_FILE);
}

/**
 * Never throws. reenableAtLaunch is true ONLY when the stored value === true (fails closed); phoneTyping is false
 * ONLY when the stored value === false (a missing, corrupt or odd file leaves typing ON, the shipped behavior).
 */
export function readControlSettings(filePath: string): ControlSettings {
  try {
    return parseControlSettings(readFileSync(filePath, 'utf8'));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const DEFAULT_SETTINGS: ControlSettings = { reenableAtLaunch: false, phoneTyping: true };

/** Unparseable text or anything but a plain object reads as defaults. Never throws. */
function parseControlSettings(text: string): ControlSettings {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...DEFAULT_SETTINGS };
    const rec = parsed as Record<string, unknown>;
    return { reenableAtLaunch: rec.reenableAtLaunch === true, phoneTyping: rec.phoneTyping !== false };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Merge read for a write: a missing file is defaults; any other read error rethrows so the write aborts untouched. */
function readForMerge(filePath: string): ControlSettings {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw err;
  }
  return parseControlSettings(text);
}

/**
 * Merges the patch over the current file (defaults when it is missing or corrupt; any other read error aborts the
 * write and leaves the file untouched) and writes both fields by atomic tmp-then-rename,
 * then returns the READBACK from disk, never the requested values: a failed write shows whatever the file still
 * says. Never throws.
 */
export function writeControlSettings(
  aetherDir: string,
  patch: Partial<ControlSettings>,
  log?: (line: string) => void,
): ControlSettings {
  const targetPath = controlSettingsPath(aetherDir);
  const tmpPath = uniqueSiblingPath(targetPath, 'aethertmp');
  try {
    const next = { ...readForMerge(targetPath), ...patch };
    mkdirSync(aetherDir, { recursive: true });
    writeFileSync(
      tmpPath,
      JSON.stringify({ v: 1, reenableAtLaunch: next.reenableAtLaunch, phoneTyping: next.phoneTyping }),
      'utf8',
    );
    renameSync(tmpPath, targetPath);
  } catch (err) {
    // Fixed string plus the errno code only: never the message, a path or the value.
    const raw = (err as NodeJS.ErrnoException | undefined)?.code;
    const code = typeof raw === 'string' && /^[A-Z0-9_]+$/.test(raw) ? raw : 'unknown';
    try {
      log?.(`control: settings write failed code=${code}`);
    } catch {
      // a logger must not break the never-throws contract
    }
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best effort
    }
  }
  return readControlSettings(targetPath);
}

/** True ONLY when the file parses to a non-array object whose reenableAtLaunch === true. Never throws; fails closed. */
export function readReenable(filePath: string): boolean {
  return readControlSettings(filePath).reenableAtLaunch;
}

/** Writes reenableAtLaunch only (phoneTyping is preserved); returns the READBACK. Never throws. */
export function writeReenable(aetherDir: string, on: boolean, log?: (line: string) => void): boolean {
  return writeControlSettings(aetherDir, { reenableAtLaunch: on }, log).reenableAtLaunch;
}

/** False ONLY when the stored phoneTyping === false; anything else is ON. Never throws. */
export function readPhoneTyping(filePath: string): boolean {
  return readControlSettings(filePath).phoneTyping;
}

/** Writes phoneTyping only (reenableAtLaunch is preserved); returns the READBACK. Never throws. */
export function writePhoneTyping(aetherDir: string, on: boolean, log?: (line: string) => void): boolean {
  return writeControlSettings(aetherDir, { phoneTyping: on }, log).phoneTyping;
}
