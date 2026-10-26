import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTROL_SETTINGS_FILE,
  controlSettingsPath,
  readControlSettings,
  readPhoneTyping,
  readReenable,
  writeControlSettings,
  writePhoneTyping,
  writeReenable,
} from './controlSettings';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aether-ctlset-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('controlSettings', () => {
  it('round-trips and writes exactly {v:1,reenableAtLaunch,phoneTyping}', () => {
    expect(readReenable(controlSettingsPath(dir))).toBe(false);
    expect(writeReenable(dir, true)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, CONTROL_SETTINGS_FILE), 'utf8'))).toEqual({ v: 1, reenableAtLaunch: true, phoneTyping: true });
    expect(writeReenable(dir, false)).toBe(false);
    expect(readReenable(controlSettingsPath(dir))).toBe(false);
    expect(readdirSync(dir)).toEqual([CONTROL_SETTINGS_FILE]); // no tmp file left behind
  });

  it('fails closed on garbage, arrays, truthy non-booleans and a missing file', () => {
    const p = controlSettingsPath(dir);
    for (const text of ['not json', '[]', 'null', '{"reenableAtLaunch":"true"}', '{"reenableAtLaunch":1}', '{}', '']) {
      writeFileSync(p, text);
      expect(readReenable(p)).toBe(false);
    }
    expect(readReenable(join(dir, 'absent.json'))).toBe(false);
  });

  it('ignores extra keys', () => {
    const p = controlSettingsPath(dir);
    writeFileSync(p, JSON.stringify({ v: 1, reenableAtLaunch: true, other: 'x' }));
    expect(readReenable(p)).toBe(true);
  });

  it('a failed write returns the old value and never throws', () => {
    expect(writeReenable(dir, true)).toBe(true);
    // a directory squatting on the target makes the rename fail
    rmSync(controlSettingsPath(dir));
    mkdirSync(controlSettingsPath(dir));
    expect(writeReenable(dir, true)).toBe(false);
    rmSync(controlSettingsPath(dir), { recursive: true });
    expect(writeReenable(dir, true)).toBe(true);
    // unwritable parent: a file where the directory should be
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    expect(writeReenable(join(blocker, 'sub'), true)).toBe(false);
  });

  it('logs one fixed code-only line per failed write, nothing on success, and survives a throwing log', () => {
    const lines: string[] = [];
    const log = (l: string): void => {
      lines.push(l);
    };
    expect(writeReenable(dir, true, log)).toBe(true);
    expect(lines).toEqual([]);
    rmSync(controlSettingsPath(dir));
    mkdirSync(controlSettingsPath(dir));
    expect(writeReenable(dir, true, log)).toBe(false);
    rmSync(controlSettingsPath(dir), { recursive: true });
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    expect(writeReenable(join(blocker, 'sub'), true, log)).toBe(false);
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).toMatch(/^control: settings write failed code=[A-Z0-9_]+$/);
      expect(l).not.toContain(dir);
      expect(l).not.toMatch(/[\\/]/);
    }
    const boom = (): void => {
      throw new Error('boom');
    };
    expect(writeReenable(join(blocker, 'sub'), true, boom)).toBe(false);
  });

  it('round-trips both flags through writeControlSettings and returns the readback', () => {
    const p = controlSettingsPath(dir);
    expect(readControlSettings(p)).toEqual({ reenableAtLaunch: false, phoneTyping: true });
    expect(writeControlSettings(dir, { reenableAtLaunch: true, phoneTyping: false })).toEqual({
      reenableAtLaunch: true,
      phoneTyping: false,
    });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ v: 1, reenableAtLaunch: true, phoneTyping: false });
    expect(readReenable(p)).toBe(true);
    expect(readPhoneTyping(p)).toBe(false);
  });

  it('neither write path resets the other flag', () => {
    const p = controlSettingsPath(dir);
    expect(writePhoneTyping(dir, false)).toBe(false);
    expect(writeReenable(dir, true)).toBe(true);
    expect(readPhoneTyping(p)).toBe(false);
    expect(writeReenable(dir, false)).toBe(false);
    expect(readPhoneTyping(p)).toBe(false);
    expect(writeReenable(dir, true)).toBe(true);
    expect(writePhoneTyping(dir, true)).toBe(true);
    expect(readReenable(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ v: 1, reenableAtLaunch: true, phoneTyping: true });
  });

  it('an old file without phoneTyping reads typing ON and the next write adds both fields', () => {
    const p = controlSettingsPath(dir);
    writeFileSync(p, JSON.stringify({ v: 1, reenableAtLaunch: true }));
    expect(readPhoneTyping(p)).toBe(true);
    expect(writeReenable(dir, false)).toBe(false);
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ v: 1, reenableAtLaunch: false, phoneTyping: true });
  });

  it('phoneTyping is OFF only for exactly false; corrupt, array and odd values leave it ON', () => {
    const p = controlSettingsPath(dir);
    writeFileSync(p, '{"phoneTyping":false}');
    expect(readPhoneTyping(p)).toBe(false);
    for (const text of ['not json', '[]', 'null', '', '{}', '{"phoneTyping":"false"}', '{"phoneTyping":0}', '{"phoneTyping":null}']) {
      writeFileSync(p, text);
      expect(readControlSettings(p)).toEqual({ reenableAtLaunch: false, phoneTyping: true });
    }
    expect(readPhoneTyping(join(dir, 'absent.json'))).toBe(true);
  });

  it('a write over a corrupt file uses defaults for the untouched flag', () => {
    const p = controlSettingsPath(dir);
    writeFileSync(p, '[1,2');
    expect(writePhoneTyping(dir, false)).toBe(false);
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ v: 1, reenableAtLaunch: false, phoneTyping: false });
  });

  it('a failed phoneTyping write returns the readback, not the request', () => {
    expect(writePhoneTyping(dir, false)).toBe(false);
    const p = controlSettingsPath(dir);
    writeFileSync(p, JSON.stringify({ v: 1, reenableAtLaunch: true, phoneTyping: false }));
    // a directory squatting on the target makes the rename fail; the squatter reads as defaults (typing ON)
    rmSync(p);
    mkdirSync(p);
    expect(writePhoneTyping(dir, false)).toBe(true);
    rmSync(p, { recursive: true });
    expect(writeControlSettings(dir, { phoneTyping: false })).toEqual({ reenableAtLaunch: false, phoneTyping: false });
    // unwritable parent: nothing there, so the readback is the defaults whatever was requested
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    expect(writeControlSettings(join(blocker, 'sub'), { phoneTyping: false, reenableAtLaunch: true })).toEqual({
      reenableAtLaunch: false,
      phoneTyping: true,
    });
  });
});
