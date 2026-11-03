import type { TierId } from './types';

export type TierEntry = {
  label: string;
  hex: string;
  bars: 0 | 1 | 2 | 3 | 4;
  glyph: 'bars' | 'sparkle';
  filled: boolean;
};

// Locked palette (design kit). Not sourced from src/styles/tokens.ts on purpose.
export const TIER_TABLE: Record<TierId, TierEntry> = {
  haiku: { label: 'haiku', hex: '#dfee5a', bars: 1, glyph: 'bars', filled: false },
  sonnet: { label: 'sonnet', hex: '#5f86ff', bars: 2, glyph: 'bars', filled: false },
  opus: { label: 'opus', hex: '#c98cff', bars: 3, glyph: 'bars', filled: false },
  fable: { label: 'fable', hex: '#d5dde6', bars: 4, glyph: 'bars', filled: true },
  design: { label: 'design', hex: '#ff8fd0', bars: 0, glyph: 'sparkle', filled: false },
};

export const ROLE_COLORS = {
  live: '#5be6ff',
  success: '#4ff0a4',
  needsYou: '#ffb454',
  failed: '#ff5c57',
} as const;

export const NEUTRALS = {
  bg: '#03070d',
  fg: '#f2fbff',
  dim: '#b8d0dc',
  line: '#2a6a8c',
  line2: '#1b4560',
} as const;

export const GLOW = {
  amber: { blurPx: 10, alpha: 0.3, pulse: false },
  red: { blurPx: 18, alpha: 0.85, pulse: true, pulseSeconds: 2.4, toBlurPx: 8, toAlpha: 0.4 },
} as const;

export const BAR_SLOTS = 4;
export const UNFILLED_BAR_OPACITY = 0.3;
export const GLYPH_GAP_PX = 10;
