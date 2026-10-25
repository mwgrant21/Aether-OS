// @vitest-environment node
import { describe, expect, it } from 'vitest';
import headlessPkg from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';
import {
  createTerminalMirror, TERMINAL_SNAPSHOT_BYTES, TERMINAL_SNAPSHOT_SCROLLBACK_LINES,
} from './terminalMirror';

type T = {
  cols: number; rows: number;
  write(d: string, cb?: () => void): void;
  resize(c: number, r: number): void;
  onData(cb: (d: string) => void): void;
  buffer: { active: { length: number; baseY: number; cursorX: number; cursorY: number; getLine(i: number): { translateToString(t: boolean): string } | undefined } };
};
const HT = (headlessPkg as unknown as { Terminal: new (o: object) => T }).Terminal;
const fresh = (cols: number, rows: number): T => new HT({ cols, rows, scrollback: 2000, allowProposedApi: true });
const settle = (t: T): Promise<void> => new Promise((r) => t.write('', r));
const visible = (t: T): string[] => {
  const b = t.buffer.active;
  return Array.from({ length: b.length }, (_, i) => b.getLine(i)!.translateToString(true)).slice(b.baseY);
};
const enc = (s: string): number => JSON.stringify(s).length;

async function replay(d: string, cols: number, rows: number): Promise<T> {
  const t = fresh(cols, rows);
  t.write(d);
  await settle(t);
  return t;
}

describe('terminalMirror', () => {
  it('(a) round trips colours, cursor moves, wide chars and scrollback', async () => {
    const m = createTerminalMirror({ cols: 60, rows: 12 });
    let s = '';
    for (let i = 0; i < 3000; i++) s += `\x1b[3${i % 8}mline ${i}\x1b[0m 中文\r\n`;
    s += '\x1b[5;10Hmoved\x1b[1;1H';
    m.write(s);
    const snap = await m.snapshot();
    const ref = fresh(60, 12);
    ref.write(s);
    await settle(ref);
    const copy = await replay(snap.d, snap.cols, snap.rows);
    expect(snap.cols).toBe(60);
    expect(visible(copy)).toEqual(visible(ref));
    expect([copy.buffer.active.cursorX, copy.buffer.active.cursorY])
      .toEqual([ref.buffer.active.cursorX, ref.buffer.active.cursorY]);
    m.dispose();
  });

  it('(b) alt-screen content survives', async () => {
    const m = createTerminalMirror({ cols: 40, rows: 8 });
    m.write('normal\r\n\x1b[?1049h\x1b[2J\x1b[HALTSCREEN');
    const snap = await m.snapshot();
    const copy = await replay(snap.d, snap.cols, snap.rows);
    expect(visible(copy).join('\n')).toContain('ALTSCREEN');
    m.dispose();
  });

  it('(c) caps scrollback at the snapshot line limit', async () => {
    const m = createTerminalMirror({ cols: 40, rows: 10 });
    let s = '';
    for (let i = 0; i < 5000; i++) s += `row${i}\r\n`;
    m.write(s);
    const snap = await m.snapshot();
    const copy = await replay(snap.d, snap.cols, snap.rows);
    expect(copy.buffer.active.baseY).toBeLessThanOrEqual(TERMINAL_SNAPSHOT_SCROLLBACK_LINES);
    expect(copy.buffer.active.baseY).toBeGreaterThan(900);
    m.dispose();
  });

  it('(d) stays within the JSON-escaped byte cap on ESC-dense content', async () => {
    const m = createTerminalMirror({ cols: 200, rows: 30 });
    let s = '';
    for (let r = 0; r < 1500; r++) {
      for (let c = 0; c < 200; c++) s += `\x1b[38;5;${(r + c) % 256}m\x1b[48;5;${(r * 7 + c) % 256}m${String.fromCharCode(65 + ((r + c) % 26))}`;
      s += '\x1b[0m\r\n';
    }
    m.write(s);
    const snap = await m.snapshot();
    expect(enc(snap.d)).toBeLessThanOrEqual(TERMINAL_SNAPSHOT_BYTES);
    expect(snap.d.length).toBeGreaterThan(0);
    m.dispose();
  });

  it('(e) snapshot is exactly the state through the last write before the call', async () => {
    const m = createTerminalMirror({ cols: 50, rows: 10 });
    let a = '';
    for (let i = 0; i < 60000; i++) a += `A${i}\r\n`; // ~500 KB: spans many parse slices
    m.write(a);
    const p = m.snapshot();
    m.write('BBBB-after\r\n');
    const snap = await p;
    expect(snap.d).toContain('A59999');
    expect(snap.d).not.toContain('BBBB');
    expect((await m.snapshot()).d).toContain('BBBB-after');

    const n = createTerminalMirror({ cols: 20, rows: 5 });
    const body = 'x'.repeat(30) + '\r\n' + 'y'.repeat(25);
    n.write(body);
    n.resize(10, 5);
    const s2 = await n.snapshot();
    expect([s2.cols, s2.rows]).toEqual([10, 5]);
    const ref = fresh(20, 5);
    ref.write(body);
    await settle(ref);
    ref.resize(10, 5);
    expect(visible(await replay(s2.d, 10, 5))).toEqual(visible(ref));
    // a snapshot taken before a later resize keeps the old size
    const before = n.snapshot();
    n.resize(30, 5);
    expect((await before).cols).toBe(10);
    expect((await n.snapshot()).cols).toBe(30);
    m.dispose();
    n.dispose();
  });

  it('(f) query sequences throw nothing and are never answered', async () => {
    const m = createTerminalMirror({ cols: 40, rows: 5 });
    expect(() => m.write('\x1b[c\x1b[6n\x1b]11;?\x07ok')).not.toThrow();
    expect((await m.snapshot()).d).toContain('ok');
    // liveness control: a bare terminal does answer these, so the module's silence is by design
    const raw = fresh(40, 5);
    let replies = 0;
    raw.onData(() => { replies += 1; });
    raw.write('\x1b[c\x1b[6n');
    await settle(raw);
    expect(replies).toBeGreaterThan(0);
    m.dispose();
  });

  it('(g) both packages import under node', () => {
    expect(typeof headlessPkg.Terminal).toBe('function');
    expect(typeof serializePkg.SerializeAddon).toBe('function');
  });

  it('dispose resolves pending snapshots and ignores later calls', async () => {
    const m = createTerminalMirror({ cols: 10, rows: 3 });
    m.write('hi');
    const p = m.snapshot();
    m.dispose();
    expect((await p).d).toBeDefined();
    expect(() => { m.write('x'); m.resize(5, 5); }).not.toThrow();
    expect((await m.snapshot()).d).toBe('');
  });

  it('(h) perf: ingest 10 MB (report only)', async () => {
    const m = createTerminalMirror({ cols: 120, rows: 40 });
    const unit = 'plain text line of output ' + '\x1b[32mgreen\x1b[0m '.repeat(4) + 'tail\r\n';
    const chunk = unit.repeat(Math.ceil(16384 / unit.length));
    const total = 10 * 1024 * 1024;
    let fed = 0;
    let peak = 0;
    const t0 = performance.now();
    while (fed < total) {
      m.write(chunk);
      fed += chunk.length;
      peak = Math.max(peak, m.pendingBytes());
    }
    await m.snapshot();
    const ms = performance.now() - t0;
    console.log(`PERF ingest ${(fed / 1048576).toFixed(1)} MB in ${ms.toFixed(0)} ms, peak write backlog ${peak} units`);
    expect(m.pendingBytes()).toBe(0);
    m.dispose();
  }, 120000);

  it('(e) falls back to a plain-text viewport when scrollback 0 still exceeds the cap', async () => {
    const cols = 300, rows = 120;
    const m = createTerminalMirror({ cols, rows, scrollback: 0 });
    let s = '';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const n = r * cols + c;
        s += `\x1b[38;2;${n % 256};${(n >> 8) % 256};${r}m\x1b[48;2;${c % 256};${(n * 7) % 256};${(n >> 4) % 256}m${String.fromCharCode(65 + (n % 26))}`;
      }
      if (r < rows - 1) s += '\r\n';
    }
    s += '\x1b[0m\x1b[5;10H';
    m.write(s);
    const snap = await m.snapshot();
    expect(enc(snap.d)).toBeLessThanOrEqual(TERMINAL_SNAPSHOT_BYTES);
    expect(snap.d).not.toContain('\x1b[38');
    const ref = fresh(cols, rows);
    ref.write(s);
    await settle(ref);
    const copy = await replay(snap.d, snap.cols, snap.rows);
    expect(visible(copy)).toEqual(visible(ref));
    expect([copy.buffer.active.cursorX, copy.buffer.active.cursorY])
      .toEqual([ref.buffer.active.cursorX, ref.buffer.active.cursorY]);
    m.dispose();
  });
});
