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

export const colorsLight: ColorPalette = {
  bgBase: '#eaf6fb',
  pageRadial: 'radial-gradient(1400px 900px at 60% -10%, #d8ecf4 0%, #eef8fc 55%, #f5fbfd 100%)',
  panelGradient: 'linear-gradient(180deg, rgba(255,255,255,.85), rgba(235,248,252,.85))',
  panelBorder: 'rgba(23,140,180,.24)',
  panelInset: 'rgba(255,255,255,.7)',
  chromeBg: 'rgba(255,255,255,.6)',
  chromeBorder: 'rgba(23,140,180,.16)',
  chipBorder: 'rgba(23,140,180,.25)',
  activeBorder: 'rgba(10,120,160,.45)',
  bgTerminal: '#f5fbfd',
  textPrimary: '#04222c',
  textBody: '#0c3540',
  textSecondary: '#3c6a76',
  textMuted: '#6f97a1',
  textDim: '#84a6ae',
  accentCyan: '#0aa9c4',
  accentCyanDeep: '#0c7f95',
  accentCyanSoft: '#3fb6cc',
  success: '#1f9d6c',
  warn: '#b8801f',
  danger: '#c73f4e',
  dangerSoft: '#e08a92',
  agentHues: ['#0aa9c4', '#4a7fd8', '#1fb894', '#3fb6cc', '#5a97d8'],
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
