// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './fsJson.mjs';
const tmp = () => mkdtempSync(join(tmpdir(), 'afk-fsjson-'));
describe('readJsonSafe', () => {
  it('reports missing, invalid-json and ok without throwing', () => {
    const d = tmp();
    expect(readJsonSafe(join(d, 'nope.json'))).toEqual({ ok: false, reason: 'missing' });
    writeFileSync(join(d, 'bad.json'), '{oops');
    expect(readJsonSafe(join(d, 'bad.json'))).toEqual({ ok: false, reason: 'invalid-json' });
    writeFileSync(join(d, 'ok.json'), '{"a":1}');
    expect(readJsonSafe(join(d, 'ok.json'))).toEqual({ ok: true, value: { a: 1 } });
  });
});
describe('writeJsonAtomic', () => {
  it('creates parents, replaces the file and leaves no temp file', () => {
    const d = tmp();
    const p = join(d, 'a', 'b', 'x.json');
    writeJsonAtomic(p, { n: 1 });
    writeJsonAtomic(p, { n: 2 });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ n: 2 });
    expect(readdirSync(join(d, 'a', 'b'))).toEqual(['x.json']);
  });
  it('refuses a symlink target', (ctx) => {
    const d = tmp();
    writeFileSync(join(d, 'real.json'), '{}');
    try { symlinkSync(join(d, 'real.json'), join(d, 'link.json')); } catch { ctx.skip(); return; }
    expect(() => writeJsonAtomic(join(d, 'link.json'), { n: 1 })).toThrow(/symlink/i);
  });
});
