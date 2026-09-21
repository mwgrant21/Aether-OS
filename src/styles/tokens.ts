export interface ColorPalette {
  bgBase: string;
  pageRadial: string;
  panelGradient: string;
  panelBorder: string;
  panelInset: string;
  chromeBg: string;
  chromeBorder: string;
  chipBorder: string;
  activeBorder: string;
  bgTerminal: string;
  textPrimary: string;
  textBody: string;
  textSecondary: string;
  textMuted: string;
  textDim: string;
  accentCyan: string;
  accentCyanDeep: string;
  accentCyanSoft: string;
  success: string;
  warn: string;
  danger: string;
  dangerSoft: string;
  agentHues: readonly string[];
}

export const colors: ColorPalette = {
  bgBase: '#020a10',
  pageRadial: 'radial-gradient(1400px 900px at 60% -10%, #0a2634 0%, #04121a 55%, #020a10 100%)',
  panelGradient: 'linear-gradient(180deg, rgba(9,28,38,.8), rgba(6,18,26,.8))',
  panelBorder: 'rgba(70,180,215,.24)',
  panelInset: 'rgba(6,20,28,.7)',
  chromeBg: 'rgba(4,16,24,.6)',
  chromeBorder: 'rgba(70,180,215,.16)',
  chipBorder: 'rgba(80,190,220,.25)',
  activeBorder: 'rgba(95,220,255,.4)',
  bgTerminal: '#06141c',
  textPrimary: '#eafcff',
  textBody: '#d8f6ff',
  textSecondary: '#9fc4d1',
  textMuted: '#5f8a97',
  textDim: '#4e7c8b',
  accentCyan: '#7ef0ff',
  accentCyanDeep: '#17b8d8',
  accentCyanSoft: '#7fd8ef',
  success: '#3be0a0',
  warn: '#f5c66b',
  danger: '#ff6b7a',
  dangerSoft: '#ff9d9d',
  agentHues: ['#7ef0ff', '#8ab6ff', '#5fffe0', '#7fd8ef', '#9bd0ff'],
};

export const fonts = {
  ui: 'Rajdhani, sans-serif',
  mono: "'Space Mono', monospace",
} as const;

export const radii = {
  panel: 14,
  tile: 9,
  chip: 7,
  pill: 30,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

// Motion scale. Mirrors `space` above: a shared vocabulary so durations and
// curves stop being retyped per component. Values here are EXACTLY what the
// codebase already used when this was introduced (2026-09-18), so adopting a
// token changes nothing visually - it only moves the decision to one place.
//
// `standard` and `emphasis` are deliberately the browser defaults. The codebase
// contains zero cubic-bezier curves, which is the main reason transitions feel
// flat rather than fluid; those two slots are where a designer's curves go, and
// changing them there re-times every adopting call site at once.
//
// `continuous` is NOT a taste slot. Uninterrupted rotation and marquee-style
// flow (spin, conduitFlow, dashFlow, scan) must stay linear - easing them makes
// a constantly-rotating element visibly surge and stall each cycle.
export const motion = {
  duration: {
    fast: '.15s',   // control state change (e.g. TopBar mode pills)
    base: '.3s',
    slow: '.5s',    // disclosure: height, stroke-dasharray
    pulse: '2.4s',  // ambient breath; matches --pulse-dur's default
  },
  easing: {
    standard: 'ease',
    emphasis: 'ease-in-out',
    continuous: 'linear',
  },
} as const;
