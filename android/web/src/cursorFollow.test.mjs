// @vitest-environment node
import { describe, it, expect } from 'vitest';
import headless from '@xterm/headless';
import { followCursor } from './cursorFollow.js';

const { Terminal } = headless;
// 30 rows x 17 px = 510 tall; 100 cols x 8 px = 800 wide.
const base = {
  cursorX: 0, cursorY: 0, cols: 100, rows: 30, screenW: 800, screenH: 510,
  viewW: 400, viewH: 170, scrollLeft: 0, scrollTop: 0, followX: false,
};
const run = (o) => followCursor({ ...base, ...o });

describe('followCursor', () => {
  it('bottom-aligns the last row', () => {
    expect(run({ cursorY: 29 }).scrollTop).toBe(510 - 170);
  });
  it('leaves an already visible cursor alone', () => {
    expect(run({ cursorY: 3, scrollTop: 0, scrollLeft: 120 })).toEqual({ scrollLeft: 120, scrollTop: 0 });
    expect(run({ cursorX: 20, cursorY: 3, scrollLeft: 100, followX: true })).toEqual({ scrollLeft: 100, scrollTop: 0 });
  });
  it('top-aligns a cursor above the viewport', () => {
    expect(run({ cursorY: 5, scrollTop: 340 }).scrollTop).toBe(85);
  });
  it('returns 0 when the view is taller than the screen', () => {
    expect(run({ viewH: 600, cursorY: 29, scrollTop: 50 }).scrollTop).toBe(0);
  });
  it('followX false never changes scrollLeft', () => {
    expect(run({ cursorX: 90, scrollLeft: 0 }).scrollLeft).toBe(0);
  });
  it('followX true brings the column in', () => {
    expect(run({ cursorX: 90, followX: true }).scrollLeft).toBe(91 * 8 - 400);
  });
  it.each([[{ cols: 0 }], [{ rows: NaN }], [{ screenH: 0 }], [{ viewH: 0 }], [{ cursorY: NaN }]])(
    'returns inputs unchanged for bad dims %j',
    (o) => {
      expect(run({ ...o, cursorY: o.cursorY ?? 29, scrollTop: 7, scrollLeft: 9 })).toEqual({ scrollLeft: 9, scrollTop: 7 });
    },
  );
  it('re-bottoms when the view shrinks (IME opens)', () => {
    const a = run({ cursorY: 29, viewH: 300 });
    expect(a.scrollTop).toBe(210);
    expect(run({ cursorY: 29, viewH: 170, scrollTop: a.scrollTop }).scrollTop).toBe(340);
  });
});

describe('xterm cursorY', () => {
  it('is 23 after 40 lines in a 24-row terminal', async () => {
    const t = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    let s = '';
    for (let i = 0; i < 40; i++) s += `line ${i}${i < 39 ? '\r\n' : ''}`;
    await new Promise((r) => t.write(s, r));
    expect(t.buffer.active.cursorY).toBe(23);
  });
  it('offsetY shifts the cursor row down and extends the scrollable height', () => {
    // 200 px of history above the grid: row 29 now ends at 200 + 510 = 710.
    expect(run({ cursorY: 29, offsetY: 200 }).scrollTop).toBe(710 - 170);
    expect(run({ cursorY: 0, offsetY: 200, scrollTop: 400 }).scrollTop).toBe(200);
  });
  it('offsetY 0, absent, negative or NaN reproduces the default', () => {
    for (const offsetY of [0, undefined, -5, NaN]) {
      expect(run({ cursorY: 29, offsetY })).toEqual(run({ cursorY: 29 }));
    }
  });
});
