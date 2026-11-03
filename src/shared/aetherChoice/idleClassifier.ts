// Pure, fail-closed classifier: visible screen rows of a Claude slot -> one IdleReading.
//
// Signatures come from transcribed screenshots in __fixtures__/screens (not harness captures).
// Only the bottom of the screen is read. The area above the live UI is redraw-garbled in the
// fixtures and is never matched. A positive match is required for every reading; anything else,
// an untested Claude version, partial coverage or a too-short screen is 'unknown'.
// The function returns only the enum: no row text leaves it.
import type { IdleReading } from './types';

/** Claude Code versions the signatures were transcribed from. Anything else reads 'unknown'. */
export const TESTED_VERSIONS: readonly string[] = ['2.1.317'];

export type ScreenInput = {
  rows: string[];
  coverage: 'full' | 'partial';
  claudeVersion: string | null;
};

const RULE = /^[─━]{10,}\s*$/;
// The two "Try ..." input placeholders seen in the fixtures. Any other text after the marker
// is treated as a typed draft (non-idle), so a new placeholder fails closed.
const PLACEHOLDER = /^Try "(how does <filepath> work\?|write a test for <filepath>)"$/;
const FOOTER = /^ {1,3}\S.*\(shift\+tab to cycle\)/;
// Any of: a row ending in an ellipsis (glyph optional), ellipsis then a parenthetical, glyph + words ending in an ellipsis (unicode or ASCII), a (Ns counter, or the interrupt hint.
const SPINNER = /…\s*\(|…\s+\d+s\b|^\s*\S\s+\S+…(\s|$)|esc to interrupt|^\s*\S\s+\S[^()]*(…|\.{3})\s*$|^\s*\S\s+\S+.*\(\d+s\b|…\s*$/;
// Rows below the lower rule (status rows, footer) are scanned for the interrupt hint only.
const BELOW_HINT = /esc to interrupt/;
const SWITCH_NOTICE = /Set model to .+ and saved as your default for new sessions/;
const PICKER_FOOT = /^\s*Enter to set as default\b.*Esc to cancel\s*$/;
const PICKER_HEAD = /^\s*Select model\s*$/;
const PERM_FOOT = /^\s*Esc to cancel\b.*Tab to amend\s*$/;
const PERM_ASK = /^\s*Do you want to proceed\?\s*$/;
const PERM_OPT = /^\s*>?\s*1\.\s+Yes\b/;
const USAGE_TABS = /\bSettings\s+Status\s+Config\s+Usage\b/;
const SHELL_PROMPT = /^PS [^>]*>\s*$/;
const VERSION = /\bClaude Code v(\d+\.\d+\.\d+)\b/;

const nonBlank = (rows: string[]): string[] => {
  const out = rows.map((r) => r.replace(/\r$/, '').replace(/\s+$/, ''));
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
};

const lastIndexWhere = (rows: string[], from: number, lo: number, re: RegExp): number => {
  for (let i = from; i >= Math.max(0, lo); i--) if (re.test(rows[i])) return i;
  return -1;
};

/** Version from the startup banner, or null when no banner row is in `rows`. */
export function extractClaudeVersion(rows: string[]): string | null {
  for (const r of rows) {
    const m = VERSION.exec(r);
    if (m) return m[1];
  }
  return null;
}

/** The nearest `count` non-empty rows above index `i`. */
function above(rows: string[], i: number, count: number): string[] {
  const out: string[] = [];
  for (let k = i - 1; k >= 0 && out.length < count; k--) if (rows[k].trim() !== '') out.push(rows[k]);
  return out;
}

function classifyInputBlock(rows: string[]): IdleReading {
  const last = rows.length - 1;
  if (!FOOTER.test(rows[last])) return 'unknown';
  // Up to two status rows (no rule, no input marker) sit between the footer and the lower rule.
  let r2 = -1;
  for (let i = last - 1; i >= Math.max(0, last - 3); i--) {
    if (RULE.test(rows[i])) {
      r2 = i;
      break;
    }
    if (rows[i].startsWith('>') || rows[i].trim() === '') return 'unknown';
  }
  if (r2 < 0) return 'unknown';
  const r1 = lastIndexWhere(rows, r2 - 1, r2 - 5, RULE);
  if (r1 < 0) return 'unknown';
  const input = rows.slice(r1 + 1, r2);
  if (input.length === 0 || !input[0].startsWith('>')) return 'unknown';

  const near = above(rows, r1, rows.length);
  if (near.some((r) => SWITCH_NOTICE.test(r))) return 'switch-model-modal';
  const text = input[0].slice(1).trim();
  if (input.length > 1 || (text !== '' && !PLACEHOLDER.test(text))) return 'draft';
  const below = rows.slice(r2 + 1);
  if (near.some((r) => SPINNER.test(r)) || below.some((r) => BELOW_HINT.test(r))) return text === '' ? 'generating' : 'unknown';
  return 'idle';
}

export function classifyScreen(input: ScreenInput): IdleReading {
  try {
    if (input.coverage !== 'full' || !Array.isArray(input.rows)) return 'unknown';
    const rows = nonBlank(input.rows.filter((r): r is string => typeof r === 'string'));
    if (rows.filter((r) => r.trim() !== '').length < 2) return 'unknown';
    const last = rows.length - 1;

    // A bare shell prompt with no Claude chrome in the last rows. Not Claude, so no version gate.
    if (SHELL_PROMPT.test(rows[last])) {
      const tail = rows.slice(Math.max(0, last - 4), last);
      if (tail.some((r) => RULE.test(r) || FOOTER.test(r))) return 'unknown';
      return 'shell';
    }

    if (input.claudeVersion === null || !TESTED_VERSIONS.includes(input.claudeVersion)) return 'unknown';

    if (PICKER_FOOT.test(rows[last])) {
      return lastIndexWhere(rows, last - 1, last - 16, PICKER_HEAD) >= 0 ? 'picker' : 'unknown';
    }
    if (PERM_FOOT.test(rows[last])) {
      const ask = lastIndexWhere(rows, last - 1, last - 12, PERM_ASK);
      return ask >= 0 && lastIndexWhere(rows, last - 1, ask, PERM_OPT) > ask ? 'modal' : 'unknown';
    }
    if (rows.some((r) => USAGE_TABS.test(r))) return 'modal';

    return classifyInputBlock(rows);
  } catch {
    return 'unknown';
  }
}
