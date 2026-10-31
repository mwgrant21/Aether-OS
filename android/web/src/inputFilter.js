// Page-side input policy (V3 Type). The page is display + keyboard only: xterm's onData
// also carries terminal-generated reports (mouse tracking, focus events) when the remote app
// enables those modes, and those must never reach the PTY as typed input. shouldSend drops
// them; everything else (letters, ESC, arrows, ctrl codes, CR, DEL, bracketed paste) passes.

const ESC = '\x1b';
const X10_MOUSE = /^\x1b\[M[\s\S]{3}$/; // ESC [ M b x y
const SGR_MOUSE = /^\x1b\[<\d+;\d+;\d+[Mm]$/; // ESC [ < b ; x ; y M|m
const URXVT_MOUSE = /^\x1b\[\d+;\d+;\d+M$/; // ESC [ b ; x ; y M (mode 1015)

export function shouldSend(data) {
  if (typeof data !== 'string' || data.length === 0) return false;
  if (data === `${ESC}[I` || data === `${ESC}[O`) return false; // focus in / out
  if (X10_MOUSE.test(data) || SGR_MOUSE.test(data) || URXVT_MOUSE.test(data)) return false;
  return true;
}

// Bridge `{t:'stdin', on}`: strictly boolean, anything else is ignored. Applies to every
// given terminal and returns the new module-level state.
export function applyStdin(terms, on, current) {
  if (typeof on !== 'boolean') return current;
  for (const term of terms) term.options.disableStdin = !on;
  return on;
}
