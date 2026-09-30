// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadDurationBaseline, DURATION_BASELINE_FILE } from './durationBaseline';

const done = (d: number) => ({ status: 'completed' as const, usage: { tokens: 1, toolUses: 1, durationMs: d } });
function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'aether-baseline-')), DURATION_BASELINE_FILE);
}

describe('loadDurationBaseline', () => {
  it('a missing file starts empty with no diag', () => {
    const diag: string[] = [];
    const b = loadDurationBaseline({ filePath: tempFile(), diag: (l) => diag.push(l) });
    expect(b.medianFor('x')).toBeNull();
    expect(diag).toEqual([]);
  });

  it('5-sample minimum', () => {
    const b = loadDurationBaseline({ filePath: tempFile(), diag: () => {}, writeFile: async () => {} });
    [100, 200, 300, 400].forEach((d) => b.record('x', done(d)));
    expect(b.medianFor('x')).toBeNull();
    b.record('x', done(500));
    expect(b.medianFor('x')).toBe(300);
  });

  it('20-sample window', () => {
    const b = loadDurationBaseline({ filePath: tempFile(), diag: () => {}, writeFile: async () => {} });
    for (let i = 0; i < 20; i++) b.record('x', done(1_000_000));
    for (let i = 0; i < 20; i++) b.record('x', done(10));
    expect(b.medianFor('x')).toBe(10);
  });

  it('rejects failed, killed, unknown, usage-less and zero-duration outcomes', () => {
    const b = loadDurationBaseline({ filePath: tempFile(), diag: () => {}, writeFile: async () => {} });
    const usage = { tokens: 1, toolUses: 1, durationMs: 5000 };
    expect(b.record('x', { status: 'failed', usage })).toBe(false);
    expect(b.record('x', { status: 'killed', usage })).toBe(false);
    expect(b.record('x', { status: 'unknown', usage })).toBe(false);
    expect(b.record('x', { status: 'completed' })).toBe(false);
    expect(b.record('x', done(0))).toBe(false);
    for (let i = 0; i < 5; i++) b.record('x', done(7));
    expect(b.medianFor('x')).toBe(7);
  });

  it('persistence round-trip through the real atomic writer; file holds numbers only', async () => {
    const filePath = tempFile();
    const a = loadDurationBaseline({ filePath, diag: () => {} });
    [10, 20, 30, 40, 50].forEach((d) => a.record('code-reviewer', done(d)));
    await a.flush();
    const json = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(json).toEqual({ version: 1, samples: { 'code-reviewer': [10, 20, 30, 40, 50] } });
    const b = loadDurationBaseline({ filePath, diag: () => {} });
    expect(b.medianFor('code-reviewer')).toBe(30);
  });

  it('a corrupt file starts empty with exactly one diag line', () => {
    const filePath = tempFile();
    writeFileSync(filePath, '{not json', 'utf8');
    const diag: string[] = [];
    const b = loadDurationBaseline({ filePath, diag: (l) => diag.push(l), writeFile: async () => {} });
    expect(b.medianFor('x')).toBeNull();
    expect(diag).toHaveLength(1);
    expect(diag[0]).toMatch(/^\[diag\] duration-baseline corrupt/);
  });

  // Review Focus 4
  it('wrong-shape JSON starts empty, one diag, never NaN', () => {
    for (const bad of ['[]', 'null', '42', '{"version":2,"samples":{}}', '{"version":1,"samples":{"x":["a",-1,null]}}', '{"version":1,"samples":[]}']) {
      const filePath = tempFile();
      writeFileSync(filePath, bad, 'utf8');
      const diag: string[] = [];
      const b = loadDurationBaseline({ filePath, diag: (l) => diag.push(l), writeFile: async () => {} });
      expect(b.medianFor('x')).toBeNull();
      expect(diag).toHaveLength(1);
      for (let i = 0; i < 5; i++) b.record('x', done(9));
      expect(b.medianFor('x')).toBe(9);
    }
  });

  it('prototype-named keys neither pollute nor throw, and survive a round-trip', async () => {
    const filePath = tempFile();
    writeFileSync(
      filePath,
      '{"version":1,"samples":{"__proto__":[1,2,3,4,5],"constructor":[2,2,2,2,2]}}',
      'utf8',
    );
    const diag: string[] = [];
    const b = loadDurationBaseline({ filePath, diag: (l) => diag.push(l) });
    expect(diag).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(b.medianFor('__proto__')).toBe(3);
    expect(b.medianFor('constructor')).toBe(2);
    expect(b.medianFor('toString')).toBeNull();
    expect(b.medianFor('hasOwnProperty')).toBeNull();
    for (let i = 0; i < 5; i++) b.record('__proto__', done(8));
    await b.flush();
    const c = loadDurationBaseline({ filePath, diag: (l) => diag.push(l) });
    expect(c.medianFor('__proto__')).toBe(6.5); // [1..5] + five 8s -> median of 10 values
    expect(diag).toEqual([]);
  });

  it('an unreadable file (non-ENOENT read error) starts empty with one diag', () => {
    const diag: string[] = [];
    const b = loadDurationBaseline({
      filePath: 'irrelevant',
      diag: (l) => diag.push(l),
      readFile: () => { const e: NodeJS.ErrnoException = new Error('EACCES'); e.code = 'EACCES'; throw e; },
      writeFile: async () => {},
    });
    expect(b.medianFor('x')).toBeNull();
    expect(diag).toHaveLength(1);
    expect(diag[0]).toContain('code=EACCES');
  });

  it('a failed write is reported through diag and never rejects flush()', async () => {
    const diag: string[] = [];
    const b = loadDurationBaseline({ filePath: tempFile(), diag: (l) => diag.push(l), writeFile: async () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); } });
    b.record('x', done(5));
    await expect(b.flush()).resolves.toBeUndefined();
    expect(diag.some((l) => l.includes('write failed code=EPERM'))).toBe(true);
  });

  it('a synchronously throwing writer also never rejects flush()', async () => {
    const diag: string[] = [];
    const b = loadDurationBaseline({ filePath: tempFile(), diag: (l) => diag.push(l), writeFile: (() => { throw new Error('boom'); }) as never });
    b.record('x', done(5));
    await expect(b.flush()).resolves.toBeUndefined();
    expect(diag.some((l) => l.includes('write failed'))).toBe(true);
  });

  it('a BOM-prefixed valid file loads with no diag, and the writer never emits a BOM', async () => {
    const filePath = tempFile();
    writeFileSync(filePath, 'FEFF{"version":1,"samples":{"x":[1,2,3,4,5]}}', 'utf8');
    const diag: string[] = [];
    const b = loadDurationBaseline({ filePath, diag: (l) => diag.push(l) });
    expect(diag).toEqual([]);
    expect(b.medianFor('x')).toBe(3);
    b.record('x', done(9));
    await b.flush();
    const bytes = readFileSync(filePath);
    expect([bytes[0], bytes[1], bytes[2]]).not.toEqual([0xef, 0xbb, 0xbf]);
  });

  it('a throwing diag never rejects flush() and later writes still run', async () => {
    let writes = 0;
    const b = loadDurationBaseline({
      filePath: tempFile(),
      diag: () => { throw new Error('diag down'); },
      writeFile: async () => { writes++; if (writes === 1) throw Object.assign(new Error('x'), { code: 'EPERM' }); },
    });
    b.record('x', done(5));
    b.record('x', done(6));
    await expect(b.flush()).resolves.toBeUndefined();
    expect(writes).toBe(2);
  });

  it('a persistent write failure logs once per distinct code; success re-arms', async () => {
    const diag: string[] = [];
    let code = 'EPERM';
    let fail = true;
    const b = loadDurationBaseline({
      filePath: tempFile(),
      diag: (l) => diag.push(l),
      writeFile: async () => { if (fail) throw Object.assign(new Error('x'), { code }); },
    });
    for (let i = 0; i < 5; i++) b.record('x', done(5));
    await b.flush();
    expect(diag).toHaveLength(1);
    code = 'ENOSPC';
    b.record('x', done(5));
    await b.flush();
    expect(diag).toHaveLength(2);
    fail = false;
    b.record('x', done(5));
    await b.flush();
    fail = true;
    code = 'ENOSPC';
    b.record('x', done(5));
    await b.flush();
    expect(diag).toHaveLength(3);
  });
});
