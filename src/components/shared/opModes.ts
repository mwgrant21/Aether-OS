import type { CSSProperties } from 'react';
import type { OpMode } from '../../state/types';
import { glows, type ColorPalette } from '../../styles/tokens';

// The one operating-mode table, shared by the TopBar segmented control and the
// Settings > Operating Mode card so glyph, label and meaning never drift apart.
//
// Glyphs are decoration: render them inside an aria-hidden span, so a pill's
// accessible name is just its label. U+FE0E (text presentation selector) on
// the bolt matters: without it Windows renders U+26A1 as the orange colour
// emoji, an accidental amber that ignores the pill's own text colour. With it
// the glyph inherits `color` like the diamond and pencil do.
export interface OpModeEntry {
  key: OpMode;
  glyph: string;
  label: string;
  meaning: string;
}

export const TEXT_BOLT = '⚡︎';

export const OP_MODES: readonly OpModeEntry[] = [
  { key: 'PLAN', glyph: '◇', label: 'PLAN', meaning: 'Brainstorm & plan — throttled burn, everything queued for approval' },
  { key: 'EDITS', glyph: '✎', label: 'EDITS', meaning: 'Accept edits — agents work, risky actions queue for approval' },
  { key: 'AUTO', glyph: TEXT_BOLT, label: 'AUTO', meaning: 'Full auto — low/med actions auto-approved, max burn' },
];

// The lit (active) skin of a mode pill, shared by the TopBar and Settings
// segmented controls: AUTO is amber (it hands the operator's approvals to the
// agents, so it is the one mode that asks for attention), the rest are cyan.
// Layout and the inactive skin stay with each control.
export function opModeOnSkin(colors: ColorPalette, key: OpMode): Pick<CSSProperties, 'color' | 'background' | 'boxShadow'> {
  if (key === 'AUTO') {
    return {
      color: colors.inkOnAmber,
      background: `linear-gradient(180deg,${colors.warn},${colors.warnDeep})`,
      boxShadow: glows.needsYou,
    };
  }
  return {
    color: colors.inkOnCyan,
    background: `linear-gradient(180deg,${colors.accentCyan},${colors.accentCyanDeep})`,
    boxShadow: glows.active,
  };
}
