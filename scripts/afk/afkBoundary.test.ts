// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
const strip = (s: string) => s.replace(/(^|\s)\/\*[\s\S]*?\*\//gm, '$1').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const src = Object.fromEntries(files.map((f) => [f, strip(readFileSync(join(dir, f), 'utf8'))]));
const WRITERS = ['fsJson.mjs', 'installSkill.mjs'];
const DELETERS = ['fsJson.mjs'];   // may remove only its own *.afktmp-* file after a failed atomic write
// Call forms only: the quoted rule string 'Bash(rmdir:*)' in denyRules.mjs and RegExp.exec() must not match.
// Bare `truncate(` is deliberately NOT here: it is the natural name for the 140-character title cut. `truncateSync` and `ftruncate` are.
const WRITE = /\b(writeFile|appendFile|rename|copyFile|cp|open|truncateSync|ftruncate|mkdir|mkdtemp|symlink|link|utimes|chmod|createWriteStream)(Sync)?\s*\(/;
const DELETE = /\b(unlink|rm|rmdir)(Sync)?\s*\(/;
describe('the guard patterns', () => {
  it('match call forms', () => {
    for (const s of ['fs.unlinkSync(p)', 'rmSync(p, {})', 'fs.promises.rm(p)', 'fs.rmdirSync(d)']) expect(s).toMatch(DELETE);
    for (const s of ['writeFileSync(p, x)', 'fs.renameSync(a, b)', 'openSync(p, "w")', 'fs.truncateSync(p, 0)', 'mkdirSync(d)']) expect(s).toMatch(WRITE);
  });
  it('do not match rule strings, RegExp.exec or prose', () => {
    for (const s of ["'Bash(rmdir:*)'", "'Bash(rm:*)'", "'Bash(git rm:*)'", '/x/.exec(s)', 'the removed rename note', 'truncate(title, 140)']) {
      expect(s).not.toMatch(DELETE); expect(s).not.toMatch(WRITE);
    }
  });
  it('strip keeps code after a /* inside a string literal visible', () => {
    const out = strip("const r = 'Edit(~/.aether-os/afk/**)'; /* c */ writeFileSync(p)");
    expect(out).toContain('writeFileSync(p)');
    expect(out).toMatch(WRITE);
    // The input above survives even an unguarded strip; this one (an unclosed /* in a string, then a real comment) does not.
    expect(strip("const g = '/*'; writeFileSync(p) /* c */")).toMatch(WRITE);
  });
});
describe('scripts/afk boundary', () => {
  it('is non-empty', () => { expect(files.length).toBeGreaterThan(10); });
  it('no child_process, no claude launch, no model id', () => {
    for (const [f, s] of Object.entries(src)) {
      expect(s, f).not.toMatch(/child_process/);
      expect(s, f).not.toMatch(/claude-[a-z]+-\d/);
    }
  });
  it('bypassPermissions and dangerous flags appear nowhere', () => {
    for (const [f, s] of Object.entries(src)) expect(s, f).not.toMatch(/bypassPermissions|dangerously-skip|--dangerously/i);
  });
  it('filesystem writes happen only in the reviewed writer modules', () => {
    for (const [f, s] of Object.entries(src)) if (!WRITERS.includes(f)) expect(s, f).not.toMatch(WRITE);
  });
  it('nothing deletes outside the one reviewed exception', () => {
    for (const [f, s] of Object.entries(src)) if (!DELETERS.includes(f)) expect(s, f).not.toMatch(DELETE);
  });
  it('no network listener or fetch', () => {
    for (const [f, s] of Object.entries(src)) expect(s, f).not.toMatch(/\.listen\(|createServer|\bfetch\(|node:http|node:net/);
  });
});
