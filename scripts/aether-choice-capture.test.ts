// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createRequire } from 'module';
// @ts-expect-error plain .mjs script, no declaration file
import { renderRows, escapeRaw, checkOutDir, createStatuslineWatcher, createInputDecoder } from './aether-choice-capture.mjs';

const require = createRequire(import.meta.url);
// @xterm/headless is a root devDependency only; the collector/ vitest run also
// picks this file up (../scripts/**) and cannot resolve it there.
let xtermHeadless: { Terminal: new (opts: object) => any } | null = null;
try { xtermHeadless = require('@xterm/headless'); } catch { /* unresolvable in collector/ */ }

// Probe once whether this host lets us create a directory symlink/junction.
const canSymlink = (() => {
  const d = mkdtempSync(join(tmpdir(), 'aether-capture-probe-'));
  try {
    mkdirSync(join(d, 'a'));
    symlinkSync(join(d, 'a'), join(d, 'b'), 'junction');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
})();

const made: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'aether-capture-test-'));
  made.push(d);
  return d;
}
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('aether-choice-capture', () => {
  it.skipIf(!xtermHeadless)('renderRows returns the visible rows right-trimmed (needs @xterm/headless, root install only)', async () => {
    const { Terminal } = xtermHeadless!;
    const term = new Terminal({ cols: 20, rows: 3, scrollback: 0, allowProposedApi: true });
    await new Promise<void>((r) => term.write('hello   \r\nworld', r));
    expect(renderRows(term)).toEqual(['hello', 'world', '']);
  });

  it('escapeRaw shows ESC as \x1b', () => {
    expect(escapeRaw('\x1b[31mA\x07')).toBe('\\x1b[31mA\\x07');
  });

  it('accepts a path under the temp dir', () => {
    expect(checkOutDir(join(tmp(), 'out'))).toContain('aether-capture-test-');
  });

  it('rejects an outDir inside the repo, including via .. segments', () => {
    const repo = resolve(__dirname, '..');
    expect(() => checkOutDir(join(repo, 'capture-out'))).toThrow(/repo/);
    expect(() => checkOutDir(join(tmp(), '..', '..', 'x'))).toThrow();
  });

  it('rejects ~/.claude (other than handoffs) and any other location', () => {
    const home = tmp();
    expect(() => checkOutDir(join(home, '.claude', 'x'), { home, tmpDir: join(home, 'elsewhere') })).toThrow(/\.claude/);
    expect(() => checkOutDir(join(home, 'docs'), { home, tmpDir: join(home, 'elsewhere') })).toThrow();
    expect(checkOutDir(join(home, '.claude', 'handoffs', 'a'), { home, tmpDir: join(home, 'elsewhere') })).toContain('handoffs');
  });

  it.skipIf(!canSymlink)('rejects a symlink under tmp that points into ~/.claude', () => {
    const home = tmp();
    mkdirSync(join(home, '.claude'), { recursive: true });
    const link = join(tmp(), 'link');
    symlinkSync(join(home, '.claude'), link, 'junction');
    expect(() => checkOutDir(join(link, 'sub'), { home })).toThrow(/\.claude/);
  });

  it('statusline watcher copies only on content change and never modifies the source', () => {
    const dir = tmp();
    const src = join(dir, 'statusline.json');
    const out = join(dir, 'out');
    mkdirSync(out);
    let t = 0;
    const w = createStatuslineWatcher({ src, outDir: out, nowMs: () => (t += 500) });
    expect(w.tick()).toBeNull();
    writeFileSync(src, '{"a":1}');
    expect(w.tick()).toMatch(/^statusline-0001-t\d+\.json$/);
    expect(w.tick()).toBeNull();
    writeFileSync(src, '{"a":2}');
    expect(w.tick()).toMatch(/^statusline-0002-t\d+\.json$/);
    expect(readdirSync(out)).toHaveLength(2);
    expect(readFileSync(src, 'utf8')).toBe('{"a":2}');
  });

  it('createInputDecoder decodes UTF-8 and leaves ASCII unchanged', () => {
    const dec = createInputDecoder();
    expect(dec(Buffer.from('café'))).toBe('café');
    expect(dec([...Buffer.from('echo hi\r')])).toBe('echo hi\r');
  });

  it('createInputDecoder keeps multibyte characters split across chunks', () => {
    const two = Buffer.from('é'); // 2 bytes
    const three = Buffer.from('€'); // 3 bytes
    const four = Buffer.from('😀'); // 4 bytes, three chunks
    const d1 = createInputDecoder();
    expect(d1(two.subarray(0, 1)) + d1(two.subarray(1))).toBe('é');
    const d2 = createInputDecoder();
    expect(d2(three.subarray(0, 1)) + d2(three.subarray(1, 2)) + d2(three.subarray(2))).toBe('€');
    const d3 = createInputDecoder();
    expect(d3(four.subarray(0, 2)) + d3(four.subarray(2, 3)) + d3(four.subarray(3))).toBe('😀');
  });
});
