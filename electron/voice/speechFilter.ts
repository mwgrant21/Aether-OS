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
const OPEN_LABEL = new RegExp('(?:' + SECRET_LABEL_SOURCE + '|bearer)\\W*$', 'i');
const QUOTE_OPEN = new RegExp(
  '(?<![A-Za-z0-9])(?:' + SECRET_LABEL_SOURCE + ')\\b\\\\?["\']?\\s*[:=]\\s*(\\\\?)(["\'])',
  'gi',
);

// True when s ends inside a quoted value opened after a label. The scan mirrors
// ASSIGN_RE's value alternatives (plain quote with \ escapes, or an escaped \" quote
// closed by an unescaped backslash-quote); a real newline ends either kind of value.
function inOpenValue(s: string): boolean {
  QUOTE_OPEN.lastIndex = 0;
  for (let m = QUOTE_OPEN.exec(s); m; m = QUOTE_OPEN.exec(s)) {
    const escaped = m[1] === '\\';
    const q = m[2];
    let i = m.index + m[0].length;
    let closed = false;
    while (i < s.length) {
      const c = s[i];
      if (c === '\n' || c === '\r') {
        closed = true;
        break;
      }
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
          if (s[i + 1] === q) {
            closed = true;
            break;
          }
        }
        i += s[i + 1] === '\n' || s[i + 1] === '\r' ? 1 : 2;
        continue;
      }
      if (!escaped && c === q) {
        closed = true;
        break;
      }
      i++;
    }
    if (!closed) return true;
    QUOTE_OPEN.lastIndex = i;
  }
  return false;
}

function splitsSecret(s: string, end: number): boolean {
  const head = s.slice(0, end);
  return OPEN_LABEL.test(head) || inOpenValue(head);
}

// Index just past the first complete unit in s, or -1 when there is none yet.
// A terminator (plus closers) at the very end of s is not a boundary: more text
// may follow ("3." then "14").
function findUnitEnd(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') {
      if (!splitsSecret(s, i + 1)) return i + 1;
      continue;
    }
    if (c === '.' || c === '!' || c === '?') {
      let j = i + 1;
      while (j < s.length && '"\')]'.includes(s[j])) j++;
      if (j >= s.length) return -1;
      if (/\s/.test(s[j]) && !splitsSecret(s, j + 1)) return j + 1;
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

  function process(final: boolean): string[] {
    const out: string[] = [];
    const release = (raw: string): void => {
      pending = pending.slice(raw.length);
      if (raw.length === 0) return;
      atLineStart = raw.endsWith('\n');
      const masked = maskSecrets(raw);
      if (masked.length > 0) out.push(masked);
      spokenLen += masked.length;
      if (spokenLen >= spokenCap) spokenDone = true;
    };
    for (;;) {
      if (spokenDone) {
        displayRaw += pending;
        pending = '';
        return out;
      }
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

      const begin = pending.indexOf(PEM_BEGIN);
      if (begin >= 0) {
        const end = pending.indexOf(PEM_END, begin);
        const close = end >= 0 ? pending.indexOf('-----', end + PEM_END.length) : -1;
        if (close >= 0) {
          release(pending.slice(0, close + 5));
          continue;
        }
        if (final || pending.length > PEM_HOLD_MAX) {
          if (!final && end < 0) inPemOverflow = true;
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

      const unitEnd = findUnitEnd(pending);
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
          if (/\s/.test(pending[i]) && !splitsSecret(pending, i + 1)) {
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
      return { spoken: process(false), spokenDone };
    },
    end() {
      const spoken = process(true);
      const display = capBody(maskSecrets(displayRaw), displayCap).body.trim();
      return { spoken, display, spokenDone };
    },
  };
}
