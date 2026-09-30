import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiagLog } from './diagLog';

let root: string;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diaglog-'));
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe('createDiagLog', () => {
  it('appends in order, creates a missing dir, and still console.errors', () => {
    const dir = join(root, 'nested', 'dir');
    const log = createDiagLog({ dir });
    log.write('a');
    log.write('b');
    expect(readFileSync(join(dir, 'diag.log'), 'utf8')).toBe('a\nb\n');
    expect(errSpy).toHaveBeenCalledWith('a');
  });

  it('rotates to diag.log.1 holding the old content, with a fresh diag.log', () => {
    const log = createDiagLog({ dir: root, maxBytes: 5 });
    log.write('first-line');
    log.write('second');
    expect(readFileSync(join(root, 'diag.log.1'), 'utf8')).toBe('first-line\n');
    expect(readFileSync(join(root, 'diag.log'), 'utf8')).toBe('second\n');
  });

  it('a second rotation replaces .1 and never makes a .2', () => {
    const log = createDiagLog({ dir: root, maxBytes: 5 });
    log.write('first-line');
    log.write('second-line');
    log.write('third-line');
    expect(readFileSync(join(root, 'diag.log.1'), 'utf8')).toBe('second-line\n');
    expect(readFileSync(join(root, 'diag.log'), 'utf8')).toBe('third-line\n');
    expect(readdirSync(root).sort()).toEqual(['diag.log', 'diag.log.1']);
    expect(existsSync(join(root, 'diag.log.2'))).toBe(false);
  });

  it('never throws on an unwritable target and reports the failure once', () => {
    const blocker = join(root, 'afile');
    writeFileSync(blocker, 'x');
    const log = createDiagLog({ dir: blocker });
    expect(() => {
      log.write('one');
      log.write('two');
      log.write('three');
    }).not.toThrow();
    const failures = errSpy.mock.calls.filter((c) => String(c[0]).includes('diag.log write failed'));
    expect(failures).toHaveLength(1);
  });

  it('still appends when the rotation rename fails, and reports it once', () => {
    const log = createDiagLog({ dir: root, maxBytes: 5 });
    log.write('first-line');
    // A directory squatting on diag.log.1 makes the rotation rename fail.
    mkdirSync(join(root, 'diag.log.1'));
    expect(() => {
      log.write('second-line');
      log.write('third-line');
    }).not.toThrow();
    expect(readFileSync(join(root, 'diag.log'), 'utf8')).toBe('first-line\nsecond-line\nthird-line\n');
    const failures = errSpy.mock.calls.filter((c) => String(c[0]).includes('diag.log write failed'));
    expect(failures).toHaveLength(1);
  });

  it('purge deletes diag.log and diag.log.1, and logging carries on afterwards', () => {
    const log = createDiagLog({ dir: root, maxBytes: 5 });
    log.write('first-line');
    log.write('second');
    expect(log.purge()).toEqual({ ok: true });
    expect(existsSync(join(root, 'diag.log'))).toBe(false);
    expect(existsSync(join(root, 'diag.log.1'))).toBe(false);
    log.write('after');
    expect(readFileSync(join(root, 'diag.log'), 'utf8')).toBe('after\n');
  });

  it('purge with nothing on disk is ok, and a failure is reported, not thrown', () => {
    expect(createDiagLog({ dir: join(root, 'never-written') }).purge()).toEqual({ ok: true });
    // A non-empty directory squatting on diag.log cannot be removed as a file.
    mkdirSync(join(root, 'diag.log', 'x'), { recursive: true });
    const r = createDiagLog({ dir: root }).purge();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/diag\.log/);
  });

  // Privacy doc §7: ~/.aether-os is user-only. POSIX modes only; Windows
  // ignores them and relies on the profile ACL.
  const posixOnly = it.skipIf(process.platform === 'win32');
  const groupOrOther = (p: string) => statSync(p).mode & 0o077;

  posixOnly('creates the dir and the log user-only', () => {
    const dir = join(root, 'fresh');
    createDiagLog({ dir }).write('a');
    expect(groupOrOther(dir)).toBe(0);
    expect(groupOrOther(join(dir, 'diag.log'))).toBe(0);
  });

  posixOnly('tightens a log and a rotated log an older build left world-readable', () => {
    writeFileSync(join(root, 'diag.log'), 'old\n');
    writeFileSync(join(root, 'diag.log.1'), 'older\n');
    chmodSync(join(root, 'diag.log'), 0o644);
    chmodSync(join(root, 'diag.log.1'), 0o644);
    createDiagLog({ dir: root }).write('new');
    expect(groupOrOther(join(root, 'diag.log'))).toBe(0);
    expect(groupOrOther(join(root, 'diag.log.1'))).toBe(0);
  });

  posixOnly('a rotation keeps both files user-only', () => {
    const log = createDiagLog({ dir: root, maxBytes: 5 });
    log.write('first-line');
    log.write('second');
    expect(groupOrOther(join(root, 'diag.log'))).toBe(0);
    expect(groupOrOther(join(root, 'diag.log.1'))).toBe(0);
  });
});
