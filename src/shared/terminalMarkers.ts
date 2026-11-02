// Pure status-marker matcher for terminal buffers. No xterm import: BufferLike is structural so
// both Terminal.buffer.active and a headless buffer satisfy it.
// A marker ([STOP] [WARN] [MANUAL] [ASK], uppercase) at logical-line start (after indent and at most
// one bullet glyph) starts a block: chip + colored rest, and every following non-blank row up to the
// next blank row, fence or marker line is colored too (isWrapped is not trusted: Ink's alt-screen
// redraw sets it unpredictably). A marker mid-line, outside a block, gets a chip on the token alone.
// Rows inside a ``` fence produce nothing; a fence is tracked from the first row scanned, so an
// unclosed fence suppresses every later row.

export type MarkerKind = 'STOP' | 'WARN' | 'MANUAL' | 'ASK';

export const MARKER_STYLE: Record<MarkerKind, { color: string; chipText: string }> = {
  STOP: { color: '#ff5c57', chipText: '#06141c' },
  WARN: { color: '#ffb454', chipText: '#06141c' },
  MANUAL: { color: '#00e5ff', chipText: '#06141c' },
  ASK: { color: '#ffffff', chipText: '#06141c' },
};

/** One buffer row. Invariant: string index == cell column. */
export interface LineText { text: string; isWrapped: boolean }

export interface MarkerSpan {
  row: number;
  kind: MarkerKind;
  part: 'chip' | 'rest';
  x: number;
  width: number;
}

interface CellLike { getChars(): string; getWidth(): number }
export interface BufferLike {
  getLine(y: number): { isWrapped: boolean; getCell(x: number): CellLike | undefined } | undefined;
}

const MARKER_RE = /^\s*(?:[●⏺•◦▪▸>*-]\s)?\s*\[(STOP|WARN|MANUAL|ASK)\]/;

/** One char per cell: width-0 and empty cells become ' ', multi-unit cells become U+FFFF. */
export function readLineText(buf: BufferLike, absRow: number, cols: number): LineText {
  const line = buf.getLine(absRow);
  if (!line) return { text: ' '.repeat(cols), isWrapped: false };
  let text = '';
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) { text += ' '; continue; }
    const chars = cell.getChars();
    text += chars === '' ? ' ' : chars.length === 1 ? chars : '￿';
  }
  return { text, isWrapped: line.isWrapped };
}

const MID_RE = /\[(STOP|WARN|MANUAL|ASK)\]/g;

export function scanMarkerLines(lines: readonly LineText[]): MarkerSpan[] {
  const spans: MarkerSpan[] = [];
  let inFence = false;
  let cont: MarkerKind | null = null;
  lines.forEach((line, row) => {
    if (line.text.trim().startsWith('```')) { cont = null; inFence = !inFence; return; }
    if (inFence) return;
    if (line.text.trim() === '') { cont = null; return; }
    const m = MARKER_RE.exec(line.text);
    if (m) {
      const kind = m[1] as MarkerKind;
      const token = `[${kind}]`;
      const x = m[0].length - token.length;
      spans.push({ row, kind, part: 'chip', x, width: token.length });
      const restX = x + token.length;
      if (line.text.length > restX) spans.push({ row, kind, part: 'rest', x: restX, width: line.text.length - restX });
      cont = kind;
      return;
    }
    if (cont) { spans.push({ row, kind: cont, part: 'rest', x: 0, width: line.text.length }); return; }
    for (const mm of line.text.matchAll(MID_RE)) {
      spans.push({ row, kind: mm[1] as MarkerKind, part: 'chip', x: mm.index, width: mm[0].length });
    }
  });
  return spans;
}
