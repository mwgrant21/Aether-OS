import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiagLog } from './diagLog';

const renameFail = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (...a: Parameters<typeof actual.renameSync>) => {
      if (renameFail.on) throw new Error('EBUSY');
      return actual.renameSync(...a);
    },
  };
});

let root: string;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diaglog-'));
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  renameFail.on = false;
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
    renameFail.on = true;
    expect(() => {
      log.write('second-line');
      log.write('third-line');
    }).not.toThrow();
    expect(readFileSync(join(root, 'diag.log'), 'utf8')).toBe('first-line\nsecond-line\nthird-line\n');
    const failures = errSpy.mock.calls.filter((c) => String(c[0]).includes('diag.log write failed'));
    expect(failures).toHaveLength(1);
  });
});
