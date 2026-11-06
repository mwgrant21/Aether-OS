// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readTerminalBoardSnapshot, resetTerminalBoardEntry, terminalBoardFile } from './terminalBoard';
import { TERMINAL_BOARD_STALE_MS, parseBoardEntry } from '../src/shared/terminalBoard';

const NOW = 1_700_000_000_000;
const tmp = () => mkdtempSync(join(tmpdir(), 'aether-tboard-'));

// Symlink creation needs privilege on Windows; probe once (same approach as atomicWrite.test.ts).
const symlinkSupported = (() => {
  try {
    const d = tmp();
    writeFileSync(join(d, 'real'), 'x', 'utf8');
    symlinkSync(join(d, 'real'), join(d, 'link'));
    return true;
  } catch {
    return false;
  }
})();

describe('terminal board files', () => {
  it('creates a missing dir on reset, and reads both terminals as missing before that', async () => {
    const dir = join(tmp(), 'nested', 'terminal-board');
    const before = await readTerminalBoardSnapshot(dir, NOW);
    expect(before.terminals.alpha.source).toBe('missing');
    expect(before.terminals.beta.source).toBe('missing');
    expect(await resetTerminalBoardEntry(dir, 'alpha', NOW)).toEqual({ ok: true });
    expect(readdirSync(dir)).toEqual(['alpha.json']);
  });

  it('writes a valid empty entry stamped with nowMs', async () => {
    const dir = tmp();
    await resetTerminalBoardEntry(dir, 'beta', NOW);
    const parsed = parseBoardEntry(JSON.parse(readFileSync(terminalBoardFile(dir, 'beta'), 'utf8')), 'beta');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.entry.claims).toEqual([]);
      expect(parsed.entry.updatedAt).toBe(new Date(NOW).toISOString());
    }
  });

  it('reads a corrupt file as invalid and reset replaces it with a valid one', async () => {
    const dir = tmp();
    writeFileSync(terminalBoardFile(dir, 'alpha'), '{not json', 'utf8');
    expect((await readTerminalBoardSnapshot(dir, NOW)).terminals.alpha.source).toBe('invalid');
    expect(await resetTerminalBoardEntry(dir, 'alpha', NOW)).toEqual({ ok: true });
    expect((await readTerminalBoardSnapshot(dir, NOW)).terminals.alpha.source).toBe('file');
  });

  it('reports a directory at the file path as unreadable, and reset fails softly without leaving tmp files', async () => {
    const dir = tmp();
    mkdirSync(terminalBoardFile(dir, 'alpha'));
    const snap = await readTerminalBoardSnapshot(dir, NOW);
    expect(snap.terminals.alpha).toMatchObject({ source: 'invalid', reason: 'unreadable', entry: null, stale: false });
    expect(snap.terminals.beta.source).toBe('missing');
    const r = await resetTerminalBoardEntry(dir, 'alpha', NOW);
    expect(r.ok).toBe(false);
    expect(readdirSync(dir)).toEqual(['alpha.json']);
  });

  it('resolves (does not reject) when a file sits where the directory should be', async () => {
    const parent = tmp();
    const dir = join(parent, 'terminal-board');
    writeFileSync(dir, 'x', 'utf8');
    const r = await resetTerminalBoardEntry(dir, 'alpha', NOW);
    expect(r.ok).toBe(false);
    // ENOENT on Windows, ENOTDIR on POSIX: either way the read resolves with no entry.
    const v = (await readTerminalBoardSnapshot(dir, NOW)).terminals.alpha;
    expect(v.entry).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('refuses a read-only target with EACCES and leaves it unchanged', async () => {
    const dir = tmp();
    const file = terminalBoardFile(dir, 'alpha');
    writeFileSync(file, 'keep', 'utf8');
    chmodSync(file, 0o444);
    try {
      expect(await resetTerminalBoardEntry(dir, 'alpha', NOW)).toEqual({ ok: false, code: 'EACCES' });
      expect(readFileSync(file, 'utf8')).toBe('keep');
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it.skipIf(!symlinkSupported)('writes through a symlink at the target and keeps it a symlink', async () => {
    const dir = tmp();
    const realFile = join(tmp(), 'real.json');
    writeFileSync(realFile, 'old', 'utf8');
    symlinkSync(realFile, terminalBoardFile(dir, 'alpha'));
    expect(await resetTerminalBoardEntry(dir, 'alpha', NOW)).toEqual({ ok: true });
    expect(lstatSync(terminalBoardFile(dir, 'alpha')).isSymbolicLink()).toBe(true);
    expect(parseBoardEntry(JSON.parse(readFileSync(realFile, 'utf8')), 'alpha').ok).toBe(true);
  });

  it('leaves only the two board files after repeated successful resets', async () => {
    const dir = tmp();
    await resetTerminalBoardEntry(dir, 'alpha', NOW);
    await resetTerminalBoardEntry(dir, 'alpha', NOW + 1);
    await resetTerminalBoardEntry(dir, 'beta', NOW);
    expect(readdirSync(dir).sort()).toEqual(['alpha.json', 'beta.json']);
  });

  it('resetting alpha leaves beta byte-identical', async () => {
    const dir = tmp();
    await resetTerminalBoardEntry(dir, 'beta', NOW);
    const before = readFileSync(terminalBoardFile(dir, 'beta'));
    await resetTerminalBoardEntry(dir, 'alpha', NOW + 5000);
    expect(readFileSync(terminalBoardFile(dir, 'beta')).equals(before)).toBe(true);
  });

  it('reports a file with an old updatedAt as stale', async () => {
    const dir = tmp();
    await resetTerminalBoardEntry(dir, 'alpha', NOW - TERMINAL_BOARD_STALE_MS - 1);
    const v = (await readTerminalBoardSnapshot(dir, NOW)).terminals.alpha;
    expect(v.source).toBe('file');
    expect(v.stale).toBe(true);
  });
});
