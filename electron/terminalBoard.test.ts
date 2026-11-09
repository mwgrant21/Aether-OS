// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
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
import { writeFileAtomically } from './atomicWrite';
import { attachTerminalBoardReset, readTerminalBoardSnapshot, resetTerminalBoardEntry, terminalBoardFile } from './terminalBoard';
import { createTerminalHub } from './terminalHub';
import type { PtyLike } from './ptyLifecycle';
import { TERMINAL_BOARD_STALE_MS, parseBoardEntry } from '../src/shared/terminalBoard';

vi.mock('./atomicWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomicWrite')>();
  return { ...actual, writeFileAtomically: vi.fn(actual.writeFileAtomically) };
});

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

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('resetTerminalBoardEntry serialization', () => {
  type Write = typeof writeFileAtomically;
  const realWrite = async (...args: Parameters<Write>) =>
    (await vi.importActual<typeof import('./atomicWrite')>('./atomicWrite')).writeFileAtomically(...args);

  it('runs overlapping resets of one file in call order', async () => {
    const dir = tmp();
    const log: string[] = [];
    const gate = deferred();
    const entered = deferred();
    vi.mocked(writeFileAtomically).mockImplementationOnce(async (...args) => {
      log.push('start:A');
      entered.resolve();
      await gate.promise;
      await realWrite(...args);
      log.push('end:A');
    });
    vi.mocked(writeFileAtomically).mockImplementationOnce(async (...args) => {
      log.push('start:B');
      await realWrite(...args);
      log.push('end:B');
    });
    const a = resetTerminalBoardEntry(dir, 'alpha', NOW);
    await entered.promise;
    const b = resetTerminalBoardEntry(dir, 'alpha', NOW + 1000);
    await readTerminalBoardSnapshot(dir, NOW);
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    gate.resolve();
    await Promise.all([a, b]);
    expect(log).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
    const parsed = parseBoardEntry(JSON.parse(readFileSync(terminalBoardFile(dir, 'alpha'), 'utf8')), 'alpha');
    expect(parsed.ok && parsed.entry.updatedAt).toBe(new Date(NOW + 1000).toISOString());
  });

  it('a failed reset does not block the next one on the same file', async () => {
    const dir = tmp();
    vi.mocked(writeFileAtomically).mockImplementationOnce(async () => {
      throw Object.assign(new Error('x'), { code: 'ENOSPC' });
    });
    const results = await Promise.all([
      resetTerminalBoardEntry(dir, 'alpha', NOW),
      resetTerminalBoardEntry(dir, 'alpha', NOW + 1000),
    ]);
    expect(results).toEqual([{ ok: false, code: 'ENOSPC' }, { ok: true }]);
    expect(parseBoardEntry(JSON.parse(readFileSync(terminalBoardFile(dir, 'alpha'), 'utf8')), 'alpha').ok).toBe(true);
  });

  it('does not serialize across different files', async () => {
    const dir = tmp();
    const gate = deferred();
    const entered = deferred();
    vi.mocked(writeFileAtomically).mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      await realWrite(...args);
    });
    const a = resetTerminalBoardEntry(dir, 'alpha', NOW);
    await entered.promise;
    expect(await resetTerminalBoardEntry(dir, 'beta', NOW)).toEqual({ ok: true });
    gate.resolve();
    expect(await a).toEqual({ ok: true });
  });

  it('rejects a non-string dir instead of throwing synchronously', async () => {
    let p: Promise<unknown> | undefined;
    expect(() => { p = resetTerminalBoardEntry(undefined as unknown as string, 'alpha', NOW); }).not.toThrow();
    await expect(p).rejects.toBeInstanceOf(TypeError);
  });
});

function fakePty() {
  let exit: () => void = () => {};
  let data: (s: string) => void = () => {};
  return {
    onData: (cb: (s: string) => void) => { data = cb; }, onExit: (cb: () => void) => { exit = cb; },
    emitData: (s: string) => data(s),
    kill: vi.fn(), write: vi.fn(), resize: vi.fn(),
    fireExit: () => exit(),
  } satisfies PtyLike & { fireExit(): void; emitData(s: string): void };
}
const handlers = () => ({ onData: () => {}, onAlive: () => {}, onExit: () => {} });

function wired(reset: (t: 'alpha' | 'beta') => unknown = () => {}) {
  const hub = createTerminalHub();
  const calls: string[] = [];
  const spy = (t: 'alpha' | 'beta') => { calls.push(t); return reset(t); };
  const detach = attachTerminalBoardReset({ claude: hub.slot('claude'), terminal2: hub.slot('terminal2') }, spy);
  return { hub, calls, detach };
}

describe('attachTerminalBoardReset', () => {
  it('resets alpha on every claude slot start and exit', () => {
    const { hub, calls } = wired();
    const pty = fakePty();
    hub.slot('claude').start(() => pty, handlers());
    expect(calls).toEqual(['alpha']);
    pty.emitData('x'); // 'out' event
    hub.slot('claude').resize(80, 24); // 'size' event
    expect(calls).toEqual(['alpha']);
    pty.fireExit();
    expect(calls).toEqual(['alpha', 'alpha']);
  });

  it('resets beta on every terminal2 slot start and exit', () => {
    const { hub, calls } = wired();
    const pty = fakePty();
    hub.slot('terminal2').start(() => pty, handlers());
    pty.fireExit();
    expect(calls).toEqual(['beta', 'beta']);
  });

  it('does not reset on an adopted start, still resets on its exit and on a later normal start', () => {
    const { hub, calls } = wired();
    const adopted = fakePty();
    hub.slot('claude').start(() => adopted, handlers(), undefined, { adopted: true });
    expect(calls).toEqual([]);
    adopted.fireExit();
    expect(calls).toEqual(['alpha']);
    hub.slot('claude').start(() => fakePty(), handlers());
    expect(calls).toEqual(['alpha', 'alpha']);
  });

  it('never resets for the codex slot', () => {
    const { hub, calls } = wired();
    const pty = fakePty();
    hub.slot('codex').start(() => pty, handlers());
    pty.fireExit();
    expect(calls).toEqual([]);
  });

  it('resets once per start on a replacement and not for the superseded pty exit', () => {
    const { hub, calls } = wired();
    const first = fakePty();
    const second = fakePty();
    hub.slot('claude').start(() => first, handlers());
    hub.slot('claude').start(() => second, handlers());
    first.fireExit();
    expect(calls).toEqual(['alpha', 'alpha']);
  });

  it('swallows a throwing and a rejecting reset', async () => {
    for (const reset of [() => { throw new Error('boom'); }, () => Promise.reject(new Error('boom'))]) {
      const { hub } = wired(reset);
      const pty = fakePty();
      expect(() => hub.slot('claude').start(() => pty, handlers())).not.toThrow();
      expect(() => pty.fireExit()).not.toThrow();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });

  it('stops resetting after detach', () => {
    const { hub, calls, detach } = wired();
    detach();
    const pty = fakePty();
    hub.slot('claude').start(() => pty, handlers());
    hub.slot('terminal2').start(() => fakePty(), handlers());
    expect(calls).toEqual([]);
  });

  it('main.ts wires attachTerminalBoardReset once, for both terminals and the real reset (wiring pin)', () => {
    const src = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    expect(src.match(/attachTerminalBoardReset\(/g)).toHaveLength(1);
    const call = src.slice(src.indexOf('attachTerminalBoardReset('), src.indexOf('attachTerminalBoardReset(') + 600);
    expect(call).toContain("terminalHub.slot('claude')");
    expect(call).toContain("terminalHub.slot('terminal2')");
    expect(call).toContain('resetTerminalBoardEntry');
  });
});
