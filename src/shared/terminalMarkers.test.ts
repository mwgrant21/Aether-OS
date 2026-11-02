import { describe, it, expect } from 'vitest';
import headlessPkg from '@xterm/headless';
import { MARKER_STYLE, readLineText, scanMarkerLines, type LineText } from './terminalMarkers';

interface HTerm {
  write(d: string, cb?: () => void): void;
  dispose(): void;
  buffer: { active: unknown };
}
const { Terminal } = headlessPkg as unknown as { Terminal: new (o: Record<string, unknown>) => HTerm };

const L = (text: string, isWrapped = false): LineText => ({ text, isWrapped });

async function scanHeadless(data: string, cols = 40) {
  const t = new Terminal({ cols, rows: 10, allowProposedApi: true });
  await new Promise<void>((r) => t.write(data, r));
  const buf = t.buffer.active as Parameters<typeof readLineText>[0];
  const rows = Array.from({ length: 10 }, (_, y) => readLineText(buf, y, cols));
  t.dispose();
  return { rows, spans: scanMarkerLines(rows) };
}

describe('scanMarkerLines', () => {
  it('matches all four kinds at column 0 with chip and rest spans', () => {
    const kinds = ['STOP', 'WARN', 'MANUAL', 'ASK'] as const;
    const lines = kinds.map((k) => L(`[${k}] hi`.padEnd(20)));
    const spans = scanMarkerLines(lines);
    kinds.forEach((k, row) => {
      const w = k.length + 2;
      expect(spans.filter((s) => s.row === row)).toEqual([
        { row, kind: k, part: 'chip', x: 0, width: w },
        { row, kind: k, part: 'rest', x: w, width: 20 - w },
      ]);
    });
    expect(MARKER_STYLE.STOP.color).toBe('#ff5c57');
    expect(MARKER_STYLE.ASK.color).toBe('#ffffff');
  });

  it('still matches after indent and one bullet glyph, with correct columns', () => {
    const spans = scanMarkerLines([L('  [WARN] x'), L('⏺ [STOP] x'), L('  - [ASK] x')]);
    expect(spans.filter((s) => s.part === 'chip').map((s) => [s.row, s.x, s.width])).toEqual([
      [0, 2, 6], [1, 2, 6], [2, 4, 5],
    ]);
  });

  it('ignores lowercase and malformed markers', () => {
    expect(scanMarkerLines([L('[stop] x'), L('[STOPX] x'), L('[STOP ] x'), L('[ASKING] x')])).toEqual([]);
  });

  it('gives a mid-line marker a chip on the token alone, several per row, none after a block marker', () => {
    expect(scanMarkerLines([L('you run [STOP] then [ASK] ok')])).toEqual([
      { row: 0, kind: 'STOP', part: 'chip', x: 8, width: 6 },
      { row: 0, kind: 'ASK', part: 'chip', x: 20, width: 5 },
    ]);
    expect(scanMarkerLines([L('[WARN] a [STOP] b')]).map((s) => [s.kind, s.part])).toEqual([['WARN', 'chip'], ['WARN', 'rest']]);
  });

  it('colors every following non-blank row until a blank row, fence or new marker', () => {
    const spans = scanMarkerLines([
      L('[STOP] a'), L('plain'), L('- bullet [WARN] x'), L(''), L('after'),
      L('[MANUAL] m'), L('more'), L('```'), L('code'), L('[ASK] b'),
    ]);
    expect(spans.filter((s) => s.part === 'rest').map((s) => [s.row, s.kind])).toEqual([
      [0, 'STOP'], [1, 'STOP'], [2, 'STOP'], [5, 'MANUAL'], [6, 'MANUAL'],
    ]);
    expect(spans.filter((s) => s.row === 4)).toEqual([]);
    expect(spans.filter((s) => s.row === 9).map((s) => s.kind)).toEqual([]);
  });

  it('matches through ANSI-colored input written to a headless terminal', async () => {
    const { spans } = await scanHeadless('\x1b[31m[STOP]\x1b[0m halt\r\n\x1b[1;32m⏺\x1b[0m [WARN] x\r\n');
    const chips = spans.filter((s) => s.part === 'chip');
    expect(chips.map((s) => [s.row, s.kind, s.x, s.width])).toEqual([[0, 'STOP', 0, 6], [1, 'WARN', 2, 6]]);
  });

  it('colors wrapped continuation rows with rest spans and chips a marker at a wrapped row start', async () => {
    const a = await scanHeadless(`[MANUAL] ${'x'.repeat(50)}`, 20);
    expect(a.spans.filter((s) => s.row === 0).map((s) => s.part)).toEqual(['chip', 'rest']);
    expect(a.spans.filter((s) => s.row === 1)).toEqual([{ row: 1, kind: 'MANUAL', part: 'rest', x: 0, width: 20 }]);
    expect(a.spans.filter((s) => s.row === 2).map((s) => [s.part, s.x])).toEqual([['rest', 0]]);
    const b = await scanHeadless(`${'a'.repeat(20)}[STOP] x`, 20);
    expect(b.rows[1].isWrapped).toBe(true);
    expect(b.spans.map((s) => [s.row, s.part, s.x])).toEqual([[1, 'chip', 0], [1, 'rest', 6]]);
  });

  it('skips fenced code, resumes after the closing fence, and an unclosed fence suppresses the rest', () => {
    const closed = scanMarkerLines([L('```'), L('[STOP] in'), L('```'), L('[WARN] out')]);
    expect(closed.map((s) => [s.row, s.kind, s.part])).toEqual([[3, 'WARN', 'chip'], [3, 'WARN', 'rest']]);
    expect(scanMarkerLines([L('```js'), L('[STOP] in'), L('[WARN] in')])).toEqual([]);
  });

  it('keeps string index equal to cell column across wide and emoji cells', async () => {
    const { rows } = await scanHeadless('世[STOP] a\r\n😀 [STOP] b\r\n[STOP] 世x\r\n', 20);
    for (const r of rows) expect(r.text.length).toBe(20);
    expect(rows[0].text.slice(0, 2)).toBe('世 ');
    expect(rows[1].text[0]).toBe('￿');
    expect(scanMarkerLines(rows.slice(0, 2)).map((s) => [s.row, s.x, s.width])).toEqual([[0, 2, 6], [1, rows[1].text.indexOf('[STOP]'), 6]]);
    const rest = scanMarkerLines([rows[2]]).find((s) => s.part === 'rest');
    expect(rest).toEqual({ row: 0, kind: 'STOP', part: 'rest', x: 6, width: 14 });
  });
});
