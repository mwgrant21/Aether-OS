// Streaming speech filter for the voice gateway: turns model text deltas into masked
// spoken units plus one masked display block. Pure module (no node, no electron).
// Text is held and released only as complete units (a newline, or a sentence
// terminator followed by whitespace), and every unit goes through maskSecrets
// before it leaves, so a secret split across deltas cannot be matched half at a time.
// Residual limit: a secret shape longer than holdCap with no sentence break can
// straddle a forced release. A PEM block is held whole (up to PEM_HOLD_MAX).
import { capBody, maskSecrets, SECRET_LABEL_SOURCE } from '../../src/shared/board/text';
import { VOICE_DISPLAY_CAP, VOICE_SPOKEN_CAP } from '../../src/shared/voice/types';

const PEM_HOLD_MAX = 16 * 1024;
const PEM_BEGIN = '-----BEGIN ';
const PEM_END = '-----END ';
const DELIMITER = '---';

export interface SpeechFilterOptions {
  spokenCap?: number;
  holdCap?: number;
  displayCap?: number;
}

export interface SpeechFilter {
  push(delta: string): { spoken: string[]; spokenDone: boolean };
  end(): { spoken: string[]; display: string; spokenDone: boolean };
}

// A unit boundary must not separate a secret's label from its value, or the per-unit
// mask misses what the whole-text mask hides. The label alternation comes from
// maskSecrets' own ASSIGN_RE (SECRET_LABEL_SOURCE), so the two cannot drift.
const LABEL_ANY = new RegExp('(?:' + SECRET_LABEL_SOURCE + '|bearer)', 'gi');
const QUOTE_OPEN = new RegExp(
  '(?<![A-Za-z0-9])(?:' + SECRET_LABEL_SOURCE + ')\\b\\\\?["\']?\\s*[:=]\\s*(\\\\?)(["\'])',
  'gi',
);
const WORD = /\w/;

// Last head length at which a quoted value that opened at `from` is still open (s.length
// when it never closes). The scan mirrors ASSIGN_RE's value
// alternatives (plain quote with \ escapes, or an escaped \" quote closed by an
// unescaped backslash-quote); a real newline ends either kind of value.
function valueEnd(s: string, from: number, escaped: boolean, q: string): number {
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === '\n' || c === '\r') return i;
    if (c === '\\') {
      if (escaped) {
        if (s.startsWith('\\\\\\\\', i)) {
          i += 4;
          continue;
        }
        if (s.startsWith('\\\\\\' + q, i)) {
          i += 4;
          continue;
        }
        if (s[i + 1] === q) return i + 1;
      }
      i += s[i + 1] === '\n' || s[i + 1] === '\r' ? 1 : 2;
      continue;
    }
    if (!escaped && c === q) return i;
    i++;
  }
  return s.length;
}

// One forward pass over s. t[e] is 1 when cutting s after its first e characters would
// separate a label from its value: the head ends in a label (plus any non-word run) or
// inside a quoted value opened after a label. Linear in s.length, so every later lookup
// is O(1) and a hostile stream (an unterminated quote, a long run of spaces) stays cheap.
function buildUnsafe(s: string): Uint8Array {
  const n = s.length;
  const t = new Uint8Array(n + 1);
  LABEL_ANY.lastIndex = 0;
  let any = false;
  for (let m = LABEL_ANY.exec(s); m; m = LABEL_ANY.exec(s)) {
    any = true;
    LABEL_ANY.lastIndex = m.index + 1;
    const p = m.index + m[0].length;
    if (p < n && WORD.test(s[p])) continue;
    for (let e = p; e <= n; e++) {
      t[e] = 1;
      if (e < n && WORD.test(s[e])) break;
    }
  }
  if (!any) return t;
  QUOTE_OPEN.lastIndex = 0;
  for (let m = QUOTE_OPEN.exec(s); m; m = QUOTE_OPEN.exec(s)) {
    const start = m.index + m[0].length;
    const end = valueEnd(s, start, m[1] === '\\', m[2]);
    for (let e = start; e <= end; e++) t[e] = 1;
    QUOTE_OPEN.lastIndex = Math.max(end, start);
  }
  return t;
}

// Index just past the first complete unit in s, or -1 when there is none yet.
// A terminator (plus closers) at the very end of s is not a boundary: more text
// may follow ("3." then "14").
function findUnitEnd(s: string, splits: (end: number) => boolean): number {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') {
      if (!splits(i + 1)) return i + 1;
      continue;
    }
    if (c === '.' || c === '!' || c === '?') {
      let j = i + 1;
      while (j < s.length && '"\')]'.includes(s[j])) j++;
      if (j >= s.length) return -1;
      if (/\s/.test(s[j]) && !splits(j + 1)) return j + 1;
      i = j - 1;
    }
  }
  return -1;
}

export function createSpeechFilter(opts: SpeechFilterOptions = {}): SpeechFilter {
  const spokenCap = opts.spokenCap ?? VOICE_SPOKEN_CAP;
  const holdCap = opts.holdCap ?? 300;
  const displayCap = opts.displayCap ?? VOICE_DISPLAY_CAP;

  let pending = '';
  let displayRaw = '';
  let spokenDone = false;
  let atLineStart = true;
  let spokenLen = 0;
  let inPemOverflow = false;

  // Unsafe-cut table for pending (see buildUnsafe), built lazily once per change of pending.
  let unsafe: Uint8Array | null = null;
  let unsafeOff = 0;
  const splits = (end: number): boolean => {
    if (!unsafe || unsafe.length - 1 - unsafeOff !== pending.length) {
      unsafe = buildUnsafe(pending);
      unsafeOff = 0;
    }
    return unsafe[unsafeOff + end] === 1;
  };

  function process(final: boolean, prefixOnly = false): string[] {
    const out: string[] = [];
    const release = (raw: string): void => {
      // A release at a safe cut leaves the rest of the table valid; any other cut rebuilds it.
      if (unsafe) {
        if (unsafe[unsafeOff + raw.length] === 1) unsafe = null;
        else unsafeOff += raw.length;
      }
      pending = pending.slice(raw.length);
      if (raw.length === 0) return;
      atLineStart = raw.endsWith('\n');
      const masked = maskSecrets(raw);
      if (masked.length > 0) out.push(masked);
      spokenLen += masked.length;
      if (spokenLen >= spokenCap) spokenDone = true;
    };
    let prefixChecked = false;
    for (;;) {
      if (pending.length === 0) return out;

      if (inPemOverflow) {
        // Past PEM_HOLD_MAX the block was already released masked; drop the rest of it.
        if (final) {
          pending = '';
          return out;
        }
        const e = pending.indexOf(PEM_END);
        if (e < 0) {
          pending = pending.slice(-(PEM_END.length - 1));
          return out;
        }
        const c = pending.indexOf('-----', e + PEM_END.length);
        if (c < 0) {
          pending = pending.slice(e);
          return out;
        }
        pending = pending.slice(c + 5);
        inPemOverflow = false;
        continue;
      }

      if (spokenDone) {
        displayRaw += pending;
        pending = '';
        return out;
      }
      const begin = prefixOnly ? -1 : pending.indexOf(PEM_BEGIN);
      if (begin >= 0) {
        if (begin > 0 && !prefixChecked) {
          // Text before the block goes through the normal delimiter/unit logic first, so
          // output does not depend on where the deltas fell.
          const tail = pending.slice(begin);
          pending = pending.slice(0, begin);
          unsafe = null;
          out.push(...process(final, true));
          pending += tail;
          unsafe = null;
          prefixChecked = true;
          continue;
        }
        const end = pending.indexOf(PEM_END, begin);
        const close = end >= 0 ? pending.indexOf('-----', end + PEM_END.length) : -1;
        if (close >= 0) {
          prefixChecked = false;
          release(pending.slice(0, close + 5));
          continue;
        }
        if (final || pending.length > PEM_HOLD_MAX) {
          if (!final && end < 0) inPemOverflow = true;
          prefixChecked = false;
          release(pending);
          continue;
        }
        return out;
      }

      if (atLineStart) {
        const nl = pending.indexOf('\n');
        if (nl >= 0) {
          if (pending.slice(0, nl).trim() === DELIMITER) {
            spokenDone = true;
            displayRaw += pending.slice(nl + 1);
            pending = '';
            return out;
          }
        } else {
          const t = pending.trim();
          if (t === DELIMITER && final) {
            spokenDone = true;
            pending = '';
            return out;
          }
          if (t.length > 0 && DELIMITER.startsWith(t) && !final) return out;
        }
      }

      const unitEnd = findUnitEnd(pending, splits);
      if (unitEnd >= 0) {
        release(pending.slice(0, unitEnd));
        continue;
      }
      if (final || pending.length > PEM_HOLD_MAX) {
        release(pending);
        continue;
      }
      if (pending.length > holdCap) {
        let ws = -1;
        for (let i = pending.length - 1; i >= 0; i--) {
          if (/\s/.test(pending[i]) && !splits(i + 1)) {
            ws = i;
            break;
          }
        }
        if (ws >= 0) {
          release(pending.slice(0, ws + 1));
          continue;
        }
      }
      return out;
    }
  }

  return {
    push(delta) {
      pending += delta;
      unsafe = null;
      return { spoken: process(false), spokenDone };
    },
    end() {
      const spoken = process(true);
      const display = capBody(maskSecrets(displayRaw), displayCap).body.trim();
      return { spoken, display, spokenDone };
    },
  };
}
