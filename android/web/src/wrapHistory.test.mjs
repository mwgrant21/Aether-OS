// @vitest-environment node
import { describe, it, expect } from 'vitest';
import headless from '@xterm/headless';
import { readFileSync } from 'node:fs';
import { THEME } from './theme.js';
import { settledLines, isRuled, paletteCss, needsRebuild, renderHistory } from './wrapHistory.js';

const { Terminal } = headless;
const mk = (o = {}) => new Terminal({ cols: 20, rows: 5, scrollback: 2000, allowProposedApi: true, ...o });
const write = (t, d) => new Promise((r) => t.write(d, r));
const text = (res) => res.lines.map((l) => l.runs.map((r) => r.text).join(''));
const nums = (n, from = 0) => Array.from({ length: n }, (_, i) => `L${from + i}`).join('\r\n');

describe('settledLines', () => {
  it('reports only rows above the viewport as settled', async () => {
    const t = mk();
    await write(t, nums(5));
    expect(settledLines(t).lines).toEqual([]);
    await write(t, '\r\nL5\r\nL6');
    const res = settledLines(t);
    expect(text(res)).toEqual(['L0', 'L1']);
    expect(t.buffer.active.baseY).toBe(2);
  });

  it('keeps character parity with what was written, minus trailing blanks', async () => {
    const t = mk();
    const src = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(i % 7)}  `);
    await write(t, src.join('\r\n') + '\r\n');
    const res = settledLines(t);
    const expected = src.slice(0, res.lines.length).map((s) => s.replace(/ +$/, ''));
    expect(res.lines.length).toBeGreaterThan(30);
    expect(text(res)).toEqual(expected);
  });

  it('joins isWrapped continuation rows into one logical line', async () => {
    const t = mk();
    const long = 'abcdefghijklmnopqrstuvwxyz0123456789'; // 36 chars -> 2 rows at 20 cols
    await write(t, `${long}\r\n${nums(8)}`);
    const res = settledLines(t);
    expect(text(res)[0]).toBe(long);
    expect(text(res)[1]).toBe('L0');
  });

  it('flags box rules as ruled and leaves text rows alone', async () => {
    const t = mk({ cols: 40 });
    await write(t, `${'─'.repeat(30)}\r\n│ hello there friend  │\r\n${nums(8)}`);
    const res = settledLines(t);
    expect(res.lines[0].ruled).toBe(true);
    expect(res.lines[1].ruled).toBe(false);
    expect(isRuled('')).toBe(false);
    expect(isRuled('─── ab')).toBe(true);
  });

  it('returns no lines in the alternate buffer', async () => {
    const t = mk();
    await write(t, nums(12));
    expect(settledLines(t).lines.length).toBeGreaterThan(0);
    await write(t, '\x1b[?1049h');
    expect(t.buffer.active.type).toBe('alternate');
    expect(settledLines(t).lines).toEqual([]);
  });

  it('caps at the last maxLines logical lines', async () => {
    const t = mk();
    await write(t, nums(1000) + '\r\n');
    const res = settledLines(t, 400);
    expect(res.lines.length).toBe(400);
    expect(text(res)[399]).toBe('L995');
    expect(settledLines(t, 3).lines.length).toBe(3);
  });

  it('a spinner redraw in the viewport never changes settled lines', async () => {
    const t = mk();
    await write(t, nums(10) + '\r\n');
    const before = settledLines(t);
    for (let i = 0; i < 50; i++) await write(t, `\r\x1b[2Kspin ${i}`);
    const after = settledLines(t);
    expect(after).toEqual(before);
  });

  it('a cursor-up box redraw never changes settled lines, even when it scrolls', async () => {
    const t = mk();
    await write(t, nums(10) + '\r\n');
    const before = settledLines(t);
    const box = '┌──┐\r\n│ab│\r\n└──┘';
    // In-place redraw from the top of the viewport: nothing scrolls, nothing settled changes.
    for (let i = 0; i < 5; i++) await write(t, `\x1b[1;1H${box}\x1b[3A\r`);
    expect(t.buffer.active.baseY).toBe(before.lines.length);
    expect(settledLines(t)).toEqual(before);
    // Redraw that scrolls the screen: existing settled lines stay a stable prefix.
    await write(t, '\x1b[5;1H\r\n\r\nnew1\r\nnew2');
    const grown = settledLines(t);
    expect(grown.lines.length).toBeGreaterThan(before.lines.length);
    expect(grown.lines.slice(0, before.lines.length)).toEqual(before.lines);
  });

  it('key changes when a line scrolls off, and when a full scrollback shifts', async () => {
    const t = mk();
    await write(t, nums(6));
    const k1 = settledLines(t).key;
    await write(t, '\r\nnext');
    const k2 = settledLines(t).key;
    expect(k2).not.toBe(k1);
    expect(settledLines(t).key).toBe(k2);

    const f = mk({ scrollback: 10 });
    await write(f, nums(30));
    const f1 = settledLines(f).key;
    expect(f.buffer.active.baseY).toBe(10);
    await write(f, '\r\nmore');
    const f2 = settledLines(f).key;
    expect(f.buffer.active.baseY).toBe(10); // baseY pinned, only line text moved
    expect(f2).not.toBe(f1);
  });
});

describe('colour and attribute mapping', () => {
  const first = async (sgr) => {
    const t = mk();
    await write(t, `${sgr}X\x1b[0m\r\n${nums(8)}`);
    return settledLines(t).lines[0].runs[0];
  };
  it('plain text has default colours and no attributes', async () => {
    expect(await first('')).toEqual({
      text: 'X', fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false,
    });
  });
  it('SGR 31 maps to palette red', async () => {
    expect((await first('\x1b[31m')).fg).toBe(paletteCss(1));
  });
  it('38;5;n maps through the 256 table', async () => {
    expect((await first('\x1b[38;5;196m')).fg).toBe('#ff0000');
    expect((await first('\x1b[38;5;244m')).fg).toBe('#808080');
    expect((await first('\x1b[38;5;9m')).fg).toBe(paletteCss(9));
  });
  it('38;2;r;g;b is direct', async () => {
    expect((await first('\x1b[38;2;18;52;86m')).fg).toBe('#123456');
  });
  it.each([
    ['1', 'bold'], ['2', 'dim'], ['3', 'italic'], ['4', 'underline'], ['7', 'inverse'],
  ])('SGR %s sets %s', async (code, field) => {
    const run = await first(`\x1b[${code}m`);
    expect(run[field]).toBe(true);
  });
  it('splits runs on style change', async () => {
    const t = mk();
    await write(t, `a\x1b[31mb\x1b[0mc\r\n${nums(8)}`);
    const runs = settledLines(t).lines[0].runs;
    expect(runs.map((r) => r.text)).toEqual(['a', 'b', 'c']);
  });
});

describe('scrolling redraw and rebuild policy', () => {
  it('a spinner that prints CRLF per frame only ever appends to the settled prefix', async () => {
    const t = mk();
    await write(t, nums(10) + '\r\n');
    let prev = settledLines(t).lines;
    for (let i = 0; i < 40; i++) {
      await write(t, `\r\x1b[2Kspin ${i}\r\n`);
      const cur = settledLines(t).lines;
      expect(cur.slice(0, prev.length)).toEqual(prev);
      prev = cur;
    }
    expect(prev.length).toBeGreaterThan(40);
  });

  it('the key can collide on a full scrollback of repeated blanks; a write still forces a rebuild', async () => {
    const t = mk({ scrollback: 10 });
    await write(t, '\r\n'.repeat(40));
    const a = settledLines(t).key;
    await write(t, '\r\n');
    expect(settledLines(t).key).toBe(a); // collision: baseY and line baseY-1 are unchanged
    expect(needsRebuild(a, a, false)).toBe(false);
    expect(needsRebuild(a, a, true)).toBe(true); // dirty (any write/snap/size) overrides
    expect(needsRebuild(a, 'other', false)).toBe(true);
    expect(needsRebuild(null, a, false)).toBe(true);
  });

  it('a cols change that reflows rows keeps the text but changes the row structure', async () => {
    const t = mk({ cols: 10, rows: 3 });
    await write(t, 'abcdefghijklmnopqrst\r\nx\r\ny\r\nz\r\nw');
    const before = text(settledLines(t));
    t.resize(30, 3);
    const after = text(settledLines(t));
    expect(before.join('')).toBe(after.join(''));
  });
});

describe('renderHistory', () => {
  const mkDoc = () => {
    const el = () => ({
      className: '', style: {}, children: [], _t: '',
      set textContent(v) { this._t = v; this.children = []; },
      get textContent() { return this._t; },
      appendChild(c) { this.children.push(c); },
      replaceChildren(...c) { this.children = c; },
    });
    return { createElement: el };
  };
  it('puts hostile text through textContent only, as literal text', () => {
    const doc = mkDoc();
    const box = doc.createElement('div');
    const evil = '<img src=x onerror=alert(1)><script>x</script>';
    renderHistory(doc, box, [
      { runs: [{ text: evil, fg: '#cc0000', bg: null, bold: true, dim: false, italic: false, underline: false, inverse: false }], ruled: false },
      { runs: [], ruled: true },
    ]);
    expect(box.children).toHaveLength(2);
    const span = box.children[0].children[0];
    expect(span.textContent).toBe(evil);
    expect(span.children).toEqual([]);
    expect(span.style.color).toBe('#cc0000');
    expect(span.style.fontWeight).toBe('bold');
    expect(box.children[1].className).toBe('hl ruled');
  });
});

describe('Aether theme', () => {
  const mkDoc = () => {
    const el = () => ({
      className: '', style: {}, children: [], _t: '',
      set textContent(v) { this._t = v; this.children = []; },
      get textContent() { return this._t; },
      appendChild(c) { this.children.push(c); },
      replaceChildren(...c) { this.children = c; },
    });
    return { createElement: el };
  };
  it('inverse runs without colours fall back to the theme colours, swapped', () => {
    const doc = mkDoc();
    const box = doc.createElement('div');
    renderHistory(doc, box, [
      { runs: [{ text: 'X', fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: true }], ruled: false },
    ]);
    const span = box.children[0].children[0];
    expect(span.style.color).toBe(THEME.background);
    expect(span.style.backgroundColor).toBe(THEME.foreground);
  });
  it('app.css carries the same background and foreground as THEME', () => {
    const css = readFileSync(new URL('../../app/src/main/assets/terminal/app.css', import.meta.url), 'utf8').toLowerCase();
    expect(css).toContain(THEME.background.toLowerCase());
    expect(css).toContain(THEME.foreground.toLowerCase());
  });
});
