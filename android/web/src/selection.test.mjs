// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  cellAt, orderRange, wordBounds, cellWordBounds, clampText, sliceLines, createLongPress,
  cmpPoint, orderPoints, caretInCell, extendFromWord, dragHandle, splitSelection, liveSpan,
  joinSelectionText, clampAnchor,
} from './selection.js';

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

describe('cmpPoint / orderPoints', () => {
  const a = { line: 1, off: 5 };
  const b = { line: 2, off: 0 };
  it('compares by line, then offset; equal points compare 0', () => {
    expect(cmpPoint(a, b)).toBeLessThan(0);
    expect(cmpPoint(b, a)).toBeGreaterThan(0);
    expect(cmpPoint({ line: 1, off: 2 }, { line: 1, off: 7 })).toBeLessThan(0);
    expect(cmpPoint(a, { ...a })).toBe(0);
  });
  it('orders a reversed pair and leaves an equal pair alone', () => {
    expect(orderPoints(b, a)).toEqual([a, b]);
    expect(orderPoints(a, b)).toEqual([a, b]);
    expect(orderPoints(a, { ...a })).toEqual([a, a]);
  });
});

describe('clampAnchor', () => {
  const slot = { left: 0, right: 384, top: 0, bottom: 466 };
  it('keeps an anchor already inside the slot', () => {
    expect(clampAnchor({ x: 100, y: 99 }, slot)).toEqual({ x: 100, y: 99 });
  });
  it('pins a caret past the right edge (whole-row word on a 966 px grid) to the edge', () => {
    expect(clampAnchor({ x: 966, y: 99 }, slot)).toEqual({ x: 384, y: 99 });
    expect(clampAnchor({ x: -20, y: 99 }, slot)).toEqual({ x: 0, y: 99 });
  });
  it('keeps the anchor `inset` px inside each edge so a dot beside it stays on screen', () => {
    expect(clampAnchor({ x: 966, y: 99 }, slot, 22)).toEqual({ x: 362, y: 99 });
    expect(clampAnchor({ x: -20, y: 99 }, slot, 22)).toEqual({ x: 22, y: 99 });
    expect(clampAnchor({ x: 100, y: 99 }, slot, 22)).toEqual({ x: 100, y: 99 });
    expect(clampAnchor({ x: 966, y: 99 }, { ...slot, right: 30 }, 22)).toEqual({ x: 15, y: 99 });
  });
  it('gives null when the row is outside the slot vertically or the anchor is unusable', () => {
    expect(clampAnchor({ x: 10, y: 500 }, slot)).toBeNull();
    expect(clampAnchor({ x: 10, y: -1 }, slot)).toBeNull();
    expect(clampAnchor({ x: NaN, y: 10 }, slot)).toBeNull();
    expect(clampAnchor(null, slot)).toBeNull();
  });
});

describe('caretInCell', () => {
  const g = { left: 10, width: 80, cols: 8 };
  it('rounds to the nearest cell boundary (each cell is 10 px)', () => {
    expect(caretInCell({ ...g, x: 14 })).toBe(0);
    expect(caretInCell({ ...g, x: 16 })).toBe(1);
    expect(caretInCell({ ...g, x: 24 })).toBe(1);
    expect(caretInCell({ ...g, x: 26 })).toBe(2);
  });
  it('clamps to 0..cols', () => {
    expect(caretInCell({ ...g, x: -50 })).toBe(0);
    expect(caretInCell({ ...g, x: 500 })).toBe(8);
  });
  it('returns null on unusable input', () => {
    expect(caretInCell({ ...g, x: NaN })).toBeNull();
    expect(caretInCell({ ...g, x: 20, width: 0 })).toBeNull();
    expect(caretInCell({ ...g, x: 20, cols: 0 })).toBeNull();
  });
});

describe('extendFromWord', () => {
  const word = { s: { line: 3, off: 4 }, e: { line: 3, off: 9 } };
  it('keeps the word and grows the end when the point is after the word start', () => {
    expect(extendFromWord(word, { line: 5, off: 2 })).toEqual({ s: word.s, e: { line: 5, off: 2 } });
    expect(extendFromWord(word, word.s)).toEqual({ s: word.s, e: word.e });
    expect(extendFromWord(word, { line: 3, off: 6 })).toEqual({ s: word.s, e: word.e });
  });
  it('moves the start to a point before the word and keeps the word end', () => {
    expect(extendFromWord(word, { line: 1, off: 0 })).toEqual({ s: { line: 1, off: 0 }, e: word.e });
  });
});

describe('dragHandle', () => {
  const s = { line: 2, off: 3 };
  const e = { line: 4, off: 1 };
  it('moves the held end without swapping', () => {
    expect(dragHandle({ s, e }, 'start', { line: 1, off: 0 })).toEqual({ s: { line: 1, off: 0 }, e, which: 'start' });
    expect(dragHandle({ s, e }, 'end', { line: 6, off: 2 })).toEqual({ s, e: { line: 6, off: 2 }, which: 'end' });
  });
  it('swaps and flips which when the held handle crosses the other', () => {
    expect(dragHandle({ s, e }, 'start', { line: 5, off: 0 })).toEqual({ s: e, e: { line: 5, off: 0 }, which: 'end' });
    expect(dragHandle({ s, e }, 'end', { line: 0, off: 0 })).toEqual({ s: { line: 0, off: 0 }, e: s, which: 'start' });
  });
  it('does not swap when the handles meet exactly', () => {
    expect(dragHandle({ s, e }, 'start', e)).toEqual({ s: e, e, which: 'start' });
  });
});

describe('splitSelection', () => {
  it('puts a span wholly in history into hist only', () => {
    const s = { line: 1, off: 2 };
    const e = { line: 3, off: 4 };
    expect(splitSelection(s, e, 10)).toEqual({ hist: { s, e }, live: null });
  });
  it('puts a span wholly in the live grid into live only, as row/col', () => {
    expect(splitSelection({ line: 12, off: 2 }, { line: 13, off: 5 }, 10)).toEqual({
      hist: null,
      live: { s: { row: 2, col: 2 }, e: { row: 3, col: 5 } },
    });
  });
  it('splits a span that crosses the boundary: hist ends at the last history line, live starts at 0,0', () => {
    expect(splitSelection({ line: 8, off: 3 }, { line: 11, off: 6 }, 10)).toEqual({
      hist: { s: { line: 8, off: 3 }, e: { line: 9, off: Infinity } },
      live: { s: { row: 0, col: 0 }, e: { row: 1, col: 6 } },
    });
  });
  it('treats everything as live when there is no history', () => {
    expect(splitSelection({ line: 0, off: 1 }, { line: 2, off: 3 }, 0)).toEqual({
      hist: null,
      live: { s: { row: 0, col: 1 }, e: { row: 2, col: 3 } },
    });
  });
});

describe('liveSpan', () => {
  it('gives the start cell and the cell count across rows', () => {
    expect(liveSpan({ s: { row: 1, col: 4 }, e: { row: 3, col: 2 } }, 10)).toEqual({ col: 4, row: 1, len: 18 });
    expect(liveSpan({ s: { row: 2, col: 0 }, e: { row: 2, col: 5 } }, 10)).toEqual({ col: 0, row: 2, len: 5 });
  });
  it('returns null for an empty or inverted span or no live part', () => {
    expect(liveSpan({ s: { row: 1, col: 3 }, e: { row: 1, col: 3 } }, 10)).toBeNull();
    expect(liveSpan({ s: { row: 2, col: 3 }, e: { row: 1, col: 3 } }, 10)).toBeNull();
    expect(liveSpan(null, 10)).toBeNull();
  });
});

describe('joinSelectionText', () => {
  it('joins both parts with a newline, or with nothing when the line wraps across the seam', () => {
    expect(joinSelectionText('abc', 'def', false)).toBe('abc\ndef');
    expect(joinSelectionText('abc', 'def', true)).toBe('abcdef');
  });
  it('skips an empty part so no stray newline appears', () => {
    expect(joinSelectionText('', 'def', false)).toBe('def');
    expect(joinSelectionText('abc', '', false)).toBe('abc');
    expect(joinSelectionText('', '', true)).toBe('');
  });
});

describe('main.js wiring', () => {
  it('imports wheelBytes, which the alt-screen wheel handler calls', () => {
    const src = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
    expect(src).toMatch(/import \{[^}]*\bwheelBytes\b[^}]*\} from '\.\/altScroll\.js'/);
  });

  it('imports the combined-selection helpers the selection engine calls', () => {
    const src = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
    for (const name of ['splitSelection', 'extendFromWord', 'joinSelectionText', 'dragHandle']) {
      expect(src).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '\\./selection\\.js'`));
    }
  });
});
