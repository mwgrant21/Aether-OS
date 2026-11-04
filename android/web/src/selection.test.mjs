// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { cellAt, orderRange, wordBounds, cellWordBounds, clampText, sliceLines, createLongPress } from './selection.js';

const grid = { left: 10, top: 20, width: 100, height: 50, cols: 10, rows: 5 };

describe('cellAt', () => {
  it('maps a point to its cell', () => {
    expect(cellAt({ ...grid, x: 10, y: 20 })).toEqual({ col: 0, row: 0 });
    expect(cellAt({ ...grid, x: 35, y: 45 })).toEqual({ col: 2, row: 2 });
  });
  it('clamps points outside the grid', () => {
    expect(cellAt({ ...grid, x: -50, y: -50 })).toEqual({ col: 0, row: 0 });
    expect(cellAt({ ...grid, x: 999, y: 999 })).toEqual({ col: 9, row: 4 });
    expect(cellAt({ ...grid, x: 110, y: 70 })).toEqual({ col: 9, row: 4 });
  });
  it('returns null for non-finite or empty geometry', () => {
    expect(cellAt({ ...grid, x: NaN, y: 30 })).toBeNull();
    expect(cellAt({ ...grid, x: 30, y: Infinity })).toBeNull();
    expect(cellAt({ ...grid, x: 30, y: 30, width: 0 })).toBeNull();
    expect(cellAt({ ...grid, x: 30, y: 30, cols: 0 })).toBeNull();
  });
});

describe('orderRange', () => {
  it('swaps a reversed pair by row then col', () => {
    const a = { row: 3, col: 1 };
    const b = { row: 2, col: 9 };
    expect(orderRange(a, b)).toEqual([b, a]);
    expect(orderRange({ row: 2, col: 5 }, { row: 2, col: 1 })).toEqual([{ row: 2, col: 1 }, { row: 2, col: 5 }]);
  });
  it('keeps an ordered pair and a same-cell pair', () => {
    const a = { row: 1, col: 1 };
    const b = { row: 1, col: 4 };
    expect(orderRange(a, b)).toEqual([a, b]);
    expect(orderRange(a, { ...a })).toEqual([a, a]);
  });
});

describe('wordBounds', () => {
  it('selects the non-space run under the index', () => {
    expect(wordBounds('foo bar baz', 5)).toEqual({ start: 4, end: 7 });
  });
  it('selects only the run of spaces when on a space', () => {
    expect(wordBounds('foo   bar', 4)).toEqual({ start: 3, end: 6 });
  });
  it('handles both ends and clamps the index', () => {
    expect(wordBounds('foo bar', 0)).toEqual({ start: 0, end: 3 });
    expect(wordBounds('foo bar', 6)).toEqual({ start: 4, end: 7 });
    expect(wordBounds('foo bar', 99)).toEqual({ start: 4, end: 7 });
    expect(wordBounds('foo bar', -5)).toEqual({ start: 0, end: 3 });
  });
  it('returns an empty span for empty text', () => {
    expect(wordBounds('', 3)).toEqual({ start: 0, end: 0 });
  });
});

// xterm-like cells from a string: a wide char is a width-2 cell plus a width-0 continuation, a
// combining mark joins its base cell's chars, `pad` adds trailing empty cells.
function cellsOf(str, { wide = '', pad = 0 } = {}) {
  const out = [];
  for (const ch of str) {
    if (/\p{M}/u.test(ch)) out[out.length - 1].chars += ch;
    else if (wide.includes(ch)) out.push({ chars: ch, width: 2 }, { chars: '', width: 0 });
    else out.push({ chars: ch, width: 1 });
  }
  for (let i = 0; i < pad; i++) out.push({ chars: '', width: 1 });
  return out;
}

describe('cellWordBounds', () => {
  it('matches plain wordBounds on ASCII', () => {
    expect(cellWordBounds(cellsOf('foo bar baz', { pad: 5 }), 5)).toEqual({ start: 4, end: 7 });
  });
  it('returns cell columns when a wide char precedes the word', () => {
    const cells = cellsOf('中 foo', { wide: '中', pad: 3 }); // cells: 中 _ ' ' f o o
    expect(cellWordBounds(cells, 3)).toEqual({ start: 3, end: 6 });
    expect(cellWordBounds(cells, 5)).toEqual({ start: 3, end: 6 });
  });
  it('treats a hit on either cell of a wide char as that character', () => {
    const cells = cellsOf('中 foo', { wide: '中' });
    expect(cellWordBounds(cells, 0)).toEqual({ start: 0, end: 2 });
    expect(cellWordBounds(cells, 1)).toEqual({ start: 0, end: 2 });
  });
  it('keeps a combining char in its base cell', () => {
    const cells = cellsOf('éx foo'); // cells: e+acute x ' ' f o o
    expect(cells[0].chars.length).toBe(2);
    expect(cellWordBounds(cells, 4)).toEqual({ start: 3, end: 6 });
    expect(cellWordBounds(cells, 1)).toEqual({ start: 0, end: 2 });
  });
  it('spans a wide char inside the word', () => {
    const cells = cellsOf('a中b c', { wide: '中' }); // a 中 _ b ' ' c
    expect(cellWordBounds(cells, 3)).toEqual({ start: 0, end: 4 });
    expect(cellWordBounds(cells, 0)).toEqual({ start: 0, end: 4 });
  });
  it('gives the single cell past the last character', () => {
    expect(cellWordBounds(cellsOf('foo', { pad: 4 }), 5)).toEqual({ start: 5, end: 6 });
  });
});

describe('clampText', () => {
  it('leaves short ASCII alone and cuts long ASCII at the byte cap', () => {
    expect(clampText('hello', 10)).toBe('hello');
    expect(clampText('hello', 3)).toBe('hel');
  });
  it('counts multi-byte characters by their UTF-8 size', () => {
    expect(clampText('ééé', 4)).toBe('éé'); // 2 bytes each
    expect(clampText('€€', 5)).toBe('€'); // 3 bytes each
  });
  it('never splits a surrogate pair', () => {
    const e = '\u{1F600}'; // 4 bytes
    expect(clampText(`a${e}`, 4)).toBe('a');
    expect(clampText(`a${e}`, 5)).toBe(`a${e}`);
    expect(clampText(e, 3)).toBe('');
  });
  it('keeps text that is exactly at the boundary', () => {
    expect(clampText('abc', 3)).toBe('abc');
    expect(clampText('abc', 0)).toBe('');
  });
});

describe('sliceLines', () => {
  const lines = ['alpha beta', 'gamma', 'delta epsilon'];
  it('slices within one line', () => {
    expect(sliceLines(lines, { line: 0, off: 6 }, { line: 0, off: 10 })).toBe('beta');
  });
  it('joins several lines with newlines', () => {
    expect(sliceLines(lines, { line: 0, off: 6 }, { line: 2, off: 5 })).toBe('beta\ngamma\ndelta');
  });
  it('accepts reversed arguments', () => {
    expect(sliceLines(lines, { line: 2, off: 5 }, { line: 0, off: 6 })).toBe('beta\ngamma\ndelta');
  });
  it('clamps offsets past the end of a line', () => {
    expect(sliceLines(lines, { line: 1, off: 2 }, { line: 1, off: 99 })).toBe('mma');
    expect(sliceLines(lines, { line: 0, off: 99 }, { line: 1, off: 2 })).toBe('\nga');
  });
});

function fakeTimers() {
  let fn = null;
  return {
    setTimer: (f) => { fn = f; return 1; },
    clearTimer: vi.fn(() => { fn = null; }),
    fire: () => { const f = fn; fn = null; if (f) f(); },
    armed: () => fn !== null,
  };
}

describe('createLongPress', () => {
  const make = (extra = {}) => {
    const t = fakeTimers();
    const onFire = vi.fn();
    const lp = createLongPress({ setTimer: t.setTimer, clearTimer: t.clearTimer, onFire, ...extra });
    return { t, onFire, lp };
  };
  it('fires once with the start point', () => {
    const { t, onFire, lp } = make();
    lp.start(5, 6);
    t.fire();
    t.fire();
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith(5, 6);
  });
  it('is cancelled by a move beyond the slop', () => {
    const { t, onFire, lp } = make();
    lp.start(0, 0);
    expect(lp.move(0, 10)).toBe(true);
    t.fire();
    expect(onFire).not.toHaveBeenCalled();
  });
  it('is not cancelled by a move within the slop', () => {
    const { t, onFire, lp } = make();
    lp.start(0, 0);
    expect(lp.move(9, 9)).toBe(false);
    t.fire();
    expect(onFire).toHaveBeenCalledTimes(1);
  });
  it('is cancelled by end and re-armed by a second start', () => {
    const { t, onFire, lp } = make();
    lp.start(0, 0);
    lp.end();
    t.fire();
    expect(onFire).not.toHaveBeenCalled();
    lp.start(1, 1);
    lp.start(2, 2);
    t.fire();
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith(2, 2);
  });
  it('uses the slop it was given: 4 for a mouse, 10 for touch', () => {
    const mouse = make({ slopPx: 4 });
    mouse.lp.start(0, 0);
    expect(mouse.lp.move(3, 0)).toBe(false);
    expect(mouse.lp.move(4, 0)).toBe(true);
    const touch = make();
    touch.lp.start(0, 0);
    expect(touch.lp.move(4, 0)).toBe(false);
  });
});

describe('main.js wiring', () => {
  it('imports wheelBytes, which the alt-screen wheel handler calls', () => {
    const src = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
    expect(src).toMatch(/import \{[^}]*\bwheelBytes\b[^}]*\} from '\.\/altScroll\.js'/);
  });
});
