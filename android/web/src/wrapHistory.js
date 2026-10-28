// Pure model of the Raw page's SETTLED region: normal-buffer rows that have scrolled above
// the viewport (index < baseY). Cursor addressing cannot touch them, so wrapping is lossless.
// No DOM. Uses only the public IBufferLine/IBufferCell API.

const ANSI16 = [
  '#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
];
const hex2 = (n) => n.toString(16).padStart(2, '0');
const rgbCss = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

export function paletteCss(n) {
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  if (n < 16) return ANSI16[n];
  if (n < 232) {
    const i = n - 16;
    const lv = (v) => (v === 0 ? 0 : 55 + v * 40);
    return rgbCss(lv(Math.floor(i / 36)), lv(Math.floor(i / 6) % 6), lv(i % 6));
  }
  const g = 8 + (n - 232) * 10;
  return rgbCss(g, g, g);
}

const colour = (isDefault, isPalette, isRGB, value) => {
  if (isDefault) return null;
  if (isPalette) return paletteCss(value);
  if (isRGB) return rgbCss((value >> 16) & 255, (value >> 8) & 255, value & 255);
  return null;
};

const isBoxChar = (ch) => {
  const c = ch.codePointAt(0);
  return c >= 0x2500 && c <= 0x259f;
};

// Section 4.3: >= 60% of the non-space characters are box-drawing or block characters.
export function isRuled(text) {
  let box = 0;
  let total = 0;
  for (const ch of text) {
    if (ch === ' ' || ch === '\t') continue;
    total++;
    if (isBoxChar(ch)) box++;
  }
  return total > 0 && box / total >= 0.6;
}

const sameStyle = (a, b) =>
  a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim &&
  a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse;

// Runs for one buffer row. Wide-char tail cells (width 0) add nothing; empty cells are spaces.
function rowRuns(line, cell, trimEnd) {
  let len = line.length;
  if (trimEnd) {
    // getTrimmedLength is not public API: find the last cell holding a visible character.
    while (len > 0) {
      const c = line.getCell(len - 1, cell);
      if (c && c.getChars().trim() !== '') break;
      len--;
    }
  }
  const runs = [];
  for (let x = 0; x < len; x++) {
    const c = line.getCell(x, cell);
    if (!c || c.getWidth() === 0) continue;
    const style = {
      fg: colour(c.isFgDefault(), c.isFgPalette(), c.isFgRGB(), c.getFgColor()),
      bg: colour(c.isBgDefault(), c.isBgPalette(), c.isBgRGB(), c.getBgColor()),
      bold: !!c.isBold(), dim: !!c.isDim(), italic: !!c.isItalic(),
      underline: !!c.isUnderline(), inverse: !!c.isInverse(),
    };
    const ch = c.getChars() || ' ';
    const last = runs[runs.length - 1];
    if (last && sameStyle(last, style)) last.text += ch;
    else runs.push({ text: ch, ...style });
  }
  return runs;
}

export function settledLines(term, maxLines = 400) {
  const buf = term.buffer.active;
  const baseY = buf.baseY;
  const prev = baseY > 0 ? buf.getLine(baseY - 1) : undefined;
  const key = `${baseY}|${prev ? prev.translateToString(true) : ''}`;
  if (buf.type !== 'normal' || baseY <= 0) return { lines: [], key };

  const cell = buf.getNullCell();
  const logical = [];
  let cur = null;
  for (let y = 0; y < baseY; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    if (line.isWrapped && cur) cur.push(line);
    else {
      if (cur) logical.push(cur);
      cur = [line];
    }
  }
  if (cur) logical.push(cur);

  const lines = logical.slice(-maxLines).map((rows) => {
    const runs = [];
    rows.forEach((row, i) => {
      // Full wrapped rows keep their trailing cells; only the logical line's last row is trimmed.
      for (const p of rowRuns(row, cell, i === rows.length - 1)) {
        const last = runs[runs.length - 1];
        if (last && sameStyle(last, p)) last.text += p.text;
        else runs.push(p);
      }
    });
    const text = runs.map((r) => r.text).join('');
    return { runs, ruled: isRuled(text) };
  });
  return { lines, key };
}

// Rebuild policy for the settled DOM. The key alone can collide on a full scrollback when the
// newest scrolled-off line repeats the previous one (blank lines), so any write, snap or size
// since the last build also forces a rebuild (a cols change reflows rows, which a write-less
// size alone would otherwise miss).
export function needsRebuild(last, key, dirty) {
  return last === null || last !== key || dirty;
}

// Builds the settled region. DOM-light on purpose: `doc` is injected and only createElement,
// textContent, className and el.style.* are used (never innerHTML), so hostile terminal output
// stays literal text under the page CSP.
export function renderHistory(doc, container, lines) {
  const out = lines.map((l) => {
    const row = doc.createElement('div');
    row.className = l.ruled ? 'hl ruled' : 'hl';
    for (const r of l.runs) {
      const s = doc.createElement('span');
      s.textContent = r.text;
      let fg = r.fg;
      let bg = r.bg;
      if (r.inverse) [fg, bg] = [bg || '#0A0E14', fg || '#D5DEE8'];
      if (fg) s.style.color = fg;
      if (bg) s.style.backgroundColor = bg;
      if (r.bold) s.style.fontWeight = 'bold';
      if (r.dim) s.style.opacity = '0.6';
      if (r.italic) s.style.fontStyle = 'italic';
      if (r.underline) s.style.textDecoration = 'underline';
      row.appendChild(s);
    }
    if (!l.runs.length) row.textContent = '\u00a0';
    return row;
  });
  container.replaceChildren(...out);
}
