// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_JSON_BYTES, readJsonSafe, writeJsonAtomic } from './fsJson.mjs';
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
  const padded = (bytes: number) => `{"a":"${'x'.repeat(bytes - 8)}"}`;
  it('reads a file of exactly MAX_JSON_BYTES', () => {
    const d = tmp();
    writeFileSync(join(d, 'edge.json'), padded(MAX_JSON_BYTES));
    expect(readJsonSafe(join(d, 'edge.json')).ok).toBe(true);
  });
  it('refuses a file over MAX_JSON_BYTES as too-large', () => {
    const d = tmp();
    writeFileSync(join(d, 'big.json'), padded(MAX_JSON_BYTES + 1));
    expect(readJsonSafe(join(d, 'big.json'))).toEqual({ ok: false, reason: 'too-large' });
  });
  it('reports a directory as unreadable without throwing', () => {
    expect(readJsonSafe(tmp())).toEqual({ ok: false, reason: 'unreadable' });
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
