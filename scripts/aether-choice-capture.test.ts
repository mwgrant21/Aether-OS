// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createRequire } from 'module';
// @ts-expect-error plain .mjs script, no declaration file
import { renderRows, escapeRaw, checkOutDir, createStatuslineWatcher } from './aether-choice-capture.mjs';

const require = createRequire(import.meta.url);
const made: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'aether-capture-test-'));
  made.push(d);
  return d;
}
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('aether-choice-capture', () => {
  it('renderRows returns the visible rows right-trimmed', async () => {
    const { Terminal } = require('@xterm/headless');
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

  it('rejects a symlink under tmp that points into ~/.claude', () => {
    const home = tmp();
    mkdirSync(join(home, '.claude'), { recursive: true });
    const link = join(tmp(), 'link');
    try { symlinkSync(join(home, '.claude'), link, 'junction'); } catch { return; }
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
});
