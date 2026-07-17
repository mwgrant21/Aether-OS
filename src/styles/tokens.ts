export const colors = {
  bgBase: '#020a10',
  pageRadial: 'radial-gradient(1400px 900px at 60% -10%, #0a2634 0%, #04121a 55%, #020a10 100%)',
  panelGradient: 'linear-gradient(180deg, rgba(9,28,38,.8), rgba(6,18,26,.8))',
  panelBorder: 'rgba(70,180,215,.24)',
  chromeBorder: 'rgba(70,180,215,.16)',
  chipBorder: 'rgba(80,190,220,.25)',
  activeBorder: 'rgba(95,220,255,.4)',
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
  agentHues: ['#7ef0ff', '#8ab6ff', '#5fffe0', '#7fd8ef', '#9bd0ff'] as const,
} as const;

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
