/** Conservative observation only; never authorizes terminal input.
 * Bounded screen (default 30x100, maximum 32x160), no autowrap/wide glyph emulation. Only ASCII and
 * the captured width-one glyphs are accepted; other Unicode fails closed. Unknown persistent controls poison recognition until fresh-session reset;
 * known scrolling and bounds overflow require a new CSI 2J and full redraw.
 * Recognition requires cursor-addressed captured layout; plain logs do not qualify.
 * A terminal can deliberately paint an identical prompt: this is not authentication.
 */
export interface TrustPromptState { readonly seenAt: number | null; readonly active: boolean }

export function createTrustPromptMatcher(now: () => number = Date.now, dimensions: { rows: number; cols: number } = { rows: 30, cols: 100 }) {
  const CONTROL_LIMIT = 512;
  const validDimensions = (rows: number, cols: number) => Number.isInteger(rows) && Number.isInteger(cols) && rows >= 1 && rows <= 32 && cols >= 1 && cols <= 160;
  let geometryValid = validDimensions(dimensions.rows, dimensions.cols);
  let ROWS = geometryValid ? dimensions.rows : 30, COLS = geometryValid ? dimensions.cols : 100;
  let screen = Array.from({ length: ROWS }, () => Array<string>(COLS).fill(' '));
  let row = 0, col = 0, known = false, addressed = false, unsupportedMode = false, synchronized = false, pendingWrap = false;
  let seenAt: number | null = null;
  let mode: 'text' | 'esc' | 'csi' | 'osc' | 'oscEsc' | 'discard' | 'discardEsc' = 'text';
  let control = '', payloadLength = 0;
  const invalidate = () => { known = false; addressed = false; screen.forEach(line => line.fill(' ')); };
  const clear = () => { screen.forEach(line => line.fill(' ')); known = true; addressed = false; };
  const bounds = () => { if (row < 0 || row >= ROWS || col < 0 || col >= COLS) { invalidate(); row = 0; col = 0; pendingWrap = false; } };
  const uncertainMode = () => { unsupportedMode = true; invalidate(); };
  function safeSgr(sequence: string): boolean {
    const codes = sequence.slice(0, -1).split(';').map(value => Number(value));
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 38 || code === 48) {
        const count = codes[++i] === 2 ? 3 : codes[i] === 5 ? 1 : -1;
        if (count < 0 || i + count >= codes.length) return false;
        for (let j = 0; j < count; j++) { const color = codes[++i]; if (color < 0 || color > 255) return false; }
      } else if (![0, 1, 2, 3, 4, 5, 7, 9, 22, 23, 24, 25, 27, 29, 39, 49].includes(code)
        && !(code >= 30 && code <= 37) && !(code >= 40 && code <= 47)
        && !(code >= 90 && code <= 97) && !(code >= 100 && code <= 107)) return false;
    }
    return true;
  }
  function csi(sequence: string) {
    if (sequence === '?2026h' || sequence === '?2026l') { synchronized = sequence === '?2026h'; return; }
    if (/^[\d;]*m$/.test(sequence)) { if (!safeSgr(sequence)) uncertainMode(); return; }
    // Known cursor visibility and input-protocol controls do not paint cells.
    if (/^(?:>4;2m|[<>?][\d;]*u|>0q)$/.test(sequence)
      || /^\?(?:25|9001|1004|2004|2031)[hl]$/.test(sequence)) return;
    // xterm ignores character-dimension window operations with the current
    // default windowOptions {}. Physical PTY geometry remains owned by resize().
    if (/^8;\d+;\d+t$/.test(sequence)) return;
    if (/^\d*[ST]$/.test(sequence)) { invalidate(); return; } // known scrolling, no persistent mode
    if (!/^[\d;]*[HfABCDGJK]$/.test(sequence)) { uncertainMode(); return; }
    const final = sequence.slice(-1);
    const values = sequence.slice(0, -1).split(';').map(value => value === '' ? 0 : Number(value));
    if (values.length > (final === 'H' || final === 'f' ? 2 : 1) || values.some(value => !Number.isSafeInteger(value))) { invalidate(); return; }
    const n = values[0] || 1;
    if (final === 'J') {
      if (values[0] === 2) clear();
      else if (values[0] === 3) { /* erase scrollback only; visible screen unchanged */ }
      else if (values[0] === 0) { screen[row].fill(' ', col); for (let r = row + 1; r < ROWS; r++) screen[r].fill(' '); }
      else if (values[0] === 1) { for (let r = 0; r < row; r++) screen[r].fill(' '); screen[row].fill(' ', 0, col + 1); }
      else invalidate();
      return;
    }
    if (final === 'K') {
      if (values[0] === 0) screen[row].fill(' ', col);
      else if (values[0] === 1) screen[row].fill(' ', 0, col + 1);
      else if (values[0] === 2) screen[row].fill(' ');
      else invalidate();
      return;
    }
    pendingWrap = false;
    if (final === 'H' || final === 'f') { row = n - 1; col = (values[1] || 1) - 1; addressed = true; }
    if (final === 'A') row -= n;
    if (final === 'B') row += n;
    if (final === 'C') col += n;
    if (final === 'D') col -= n;
    if (final === 'G') col = n - 1;
    bounds();
  }
  function present() {
    if (!geometryValid || unsupportedMode || synchronized || !known || !addressed || mode !== 'text') return false;
    const lines = screen.map(line => line.join('').trim());
    const header = lines.indexOf('Accessing workspace:');
    if (header < 0) return false;
    const option = (value: string) => value.replace(/^[❯>]\s*/, '');
    const blocks: string[][] = [];
    for (let cursor = header; cursor < ROWS;) {
      while (cursor < ROWS && lines[cursor] === '') cursor++;
      if (cursor === ROWS) break;
      const block: string[] = [];
      while (cursor < ROWS && lines[cursor] !== '') block.push(lines[cursor++]);
      blocks.push(block);
    }
    const joined = (block: string[]) => block.join(' ');
    return blocks.length === 7
      && joined(blocks[0]) === 'Accessing workspace:'
      && blocks[1].length > 0 && blocks[1].every(line => line.length > 0)
      && joined(blocks[2]) === "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first."
      && joined(blocks[3]) === "Claude Code'll be able to read, edit, and execute files here."
      && joined(blocks[4]) === 'Security guide'
      && blocks[5].length === 2
      && option(blocks[5][0]) === 'No, exit'
      && option(blocks[5][1]) === 'Yes, I trust this folder'
      && joined(blocks[6]) === 'Enter to confirm · Esc to cancel';
  }
  return {
    ingest(chunk: string): void {
      for (const ch of chunk) {
        if (mode !== 'text' && ['\x18', '\x1a', '\x9c'].includes(ch)) {
          // CAN/SUB cancel controls; C1 ST terminates strings in xterm. Their
          // exact semantics are unsupported, but following bytes are visible.
          invalidate(); mode = 'text'; control = ''; continue;
        }
        if (mode === 'discard' || mode === 'discardEsc') {
          // Overlong/unsupported strings stay opaque until their terminator.
          if (ch === '\x07' || (mode === 'discardEsc' && ch === '\\')) mode = 'text';
          else mode = ch === '\x1b' ? 'discardEsc' : 'discard';
          continue;
        }
        if (mode === 'osc' || mode === 'oscEsc') {
          if (ch === '\x07' || (mode === 'oscEsc' && ch === '\\')) { if (control !== ';') uncertainMode(); mode = 'text'; continue; }
          if (++payloadLength > CONTROL_LIMIT || (mode === 'oscEsc' && ch !== '\x1b')) { uncertainMode(); mode = ch === '\x1b' ? 'discardEsc' : 'discard'; continue; }
          if (control !== ';' && ch !== '\x1b') {
            if (ch === ';') { if (!['0', '1', '2', '8'].includes(control)) uncertainMode(); control = ';'; }
            else if (control.length < 8) control += ch;
            else uncertainMode();
          }
          mode = ch === '\x1b' ? 'oscEsc' : 'osc';
          continue;
        }
        if (mode === 'esc') {
          control = ''; payloadLength = 0;
          if (ch === '[') mode = 'csi';
          else if (ch === ']') mode = 'osc';
          else { uncertainMode(); mode = ['P', 'X', '^', '_'].includes(ch) ? 'discard' : 'text'; }
          continue;
        }
        if (mode === 'csi') {
          if (ch >= '@' && ch <= '~') { csi(control + ch); control = ''; mode = 'text'; }
          else if (control.length >= CONTROL_LIMIT || ch < ' ' || ch > '?') { uncertainMode(); control = ''; mode = ch === '\x1b' ? 'esc' : 'text'; }
          else control += ch;
          continue;
        }
        if (ch === '\x1b') { mode = 'esc'; continue; }
        if (ch === '\r') { col = 0; pendingWrap = false; }
        else if (ch === '\n') { row++; pendingWrap = false; bounds(); }
        else if (ch === '\b') { if (!pendingWrap) col = Math.max(0, col - 1); pendingWrap = false; }
        else if (ch === '\t') { pendingWrap = false; col = (Math.floor(col / 8) + 1) * 8; bounds(); }
        else if (ch === '\x07') { /* bell */ }
        else if (ch < ' ' || (ch >= '\x7f' && ch <= '\x9f')) uncertainMode();
        else if (ch > '~' && !['─', '❯', '·'].includes(ch)) invalidate();
        else if (known) {
          if (pendingWrap) { invalidate(); pendingWrap = false; } // next glyph would autowrap
          else { screen[row][col] = ch; if (col === COLS - 1) pendingWrap = true; else col++; }
        }
      }
      if (present() && seenAt === null) seenAt = now();
    },
    state(): TrustPromptState { return { seenAt, active: present() }; },
    // Resize preserves history and sticky mode uncertainty. Task4 must call this
    // whenever physical PTY geometry changes, before feeding further bytes.
    resize(cols: number, rows: number): void {
      geometryValid = validDimensions(rows, cols);
      if (geometryValid) { ROWS = rows; COLS = cols; }
      screen = Array.from({ length: ROWS }, () => Array<string>(COLS).fill(' '));
      invalidate(); row = 0; col = 0; pendingWrap = false;
    },
    // Only a fresh physical session restores the assumed terminal modes.
    reset(): void { invalidate(); row = 0; col = 0; pendingWrap = false; mode = 'text'; control = ''; payloadLength = 0; seenAt = null; unsupportedMode = false; synchronized = false; },
  };
}

