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
  /** Text on filled cyan surfaces: DESIGN.md's Ink on Cyan. Filled amber uses inkOnAmber. */
  inkOnCyan: string;
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
  /** Lower stop of the amber (AUTO) pill gradient; warn is the upper stop. */
  warnDeep: string;
  /** Text on filled amber surfaces: the dark counterpart of inkOnCyan. */
  inkOnAmber: string;
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
  inkOnCyan: '#04202b',
  textPrimary: '#eafcff',
  textBody: '#d8f6ff',
  textSecondary: '#9fc4d1',
  textMuted: '#5f8a97',
  // Raised from #4e7c8b (2026-09-28, polish pass 2, AC4): the original
  // measured ~3.8-3.9:1 against the panel surface, below WCAG's 4.5:1 small-
  // text minimum. Same hue/saturation (~195deg, ~28%), lightness raised from
  // 42.5% to 46.7% -- see tokens.test.ts for the contrast proof against both
  // bgBase and the panel surface, and for the "still dimmer than textMuted" check.
  textDim: '#568898',
  accentCyan: '#7ef0ff',
  accentCyanDeep: '#17b8d8',
  accentCyanSoft: '#7fd8ef',
  success: '#3be0a0',
  warn: '#f5c66b',
  warnDeep: '#d9a13f',
  inkOnAmber: '#1a1204',
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
    // Exponential ease-out: a value settles into place instead of sliding at
    // constant speed. For readings that change (usage bars, the context arc).
    // A new named curve, not a redefinition of `standard`/`emphasis`.
    decelerate: 'cubic-bezier(0.16, 1, 0.3, 1)',
  },
} as const;

// DESIGN.md "Shadow Vocabulary", verbatim. Glow is state (Glow-Is-State): apply
// one of these only to something live, active, hovered, focused or waiting on
// the operator, never to a resting surface.
export const glows = {
  /** An active mode pill, the selected nav item, a lit control at rest. */
  active: '0 0 10px rgba(95,220,255,.4)',
  /** Small live indicators and dots. */
  hot: '0 0 8px rgba(95,240,255,.8)',
  /** An amber control waiting on the operator. */
  needsYou: '0 0 12px rgba(245,198,107,.45)',
  /** A lit surface glowing from inside, e.g. a hovered secondary button. */
  innerCharge: 'inset 0 0 14px rgba(95,240,255,.12)',
  /** DESIGN.md Buttons > Hover: the primary button's stronger hover glow. */
  primaryHover: '0 0 24px rgba(95,240,255,.65)',
  /** Modals and floating panels only. */
  overlayLift: '0 20px 60px rgba(0,0,0,.6)',
} as const;
