import { describe, expect, it } from 'vitest';
import { colors, fonts } from './tokens';

describe('tokens', () => {
  it('matches the source design doc base colors', () => {
    expect(colors.bgBase).toBe('#020a10');
    expect(colors.success).toBe('#3be0a0');
    expect(colors.danger).toBe('#ff6b7a');
  });

  it('exposes the two font stacks the design uses', () => {
    expect(fonts.ui).toContain('Rajdhani');
    expect(fonts.mono).toContain('Space Mono');
  });
});

// WCAG 2.x contrast math (relative luminance -> contrast ratio), used only to
// prove colors.textDim clears the 4.5:1 small-text minimum against both
// backgrounds it actually renders on -- see the AC4 spec note on tokens.ts's
// textDim entry. Kept local to this test file: it is a one-time audit tool,
// not something the running app needs at render time.
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}
/** Alpha-composites an rgba(...) foreground over an opaque hex background. */
function compositeOverBg(fgHex: string, fgAlpha: number, bgHex: string): string {
  const [fr, fg, fb] = hexToRgb(fgHex);
  const [br, bg, bb] = hexToRgb(bgHex);
  const mix = (f: number, b: number) => Math.round(f * fgAlpha + b * (1 - fgAlpha));
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(mix(fr, br))}${toHex(mix(fg, bg))}${toHex(mix(fb, bb))}`;
}

describe('colors.textDim contrast (AC4, WCAG 4.5:1 small-text minimum)', () => {
  // rgba(9,28,38,.8) is DESIGN.md's panel-top gradient stop, composited over bgBase.
  const panelSurface = compositeOverBg('#091c26', 0.8, colors.bgBase);

  it('reaches 4.5:1 against bgBase', () => {
    expect(contrastRatio(colors.textDim, colors.bgBase)).toBeGreaterThanOrEqual(4.5);
  });

  it('reaches 4.5:1 against the panel surface', () => {
    expect(contrastRatio(colors.textDim, panelSurface)).toBeGreaterThanOrEqual(4.5);
  });

  it('still reads dimmer than textMuted against both backgrounds', () => {
    expect(contrastRatio(colors.textDim, colors.bgBase)).toBeLessThan(contrastRatio(colors.textMuted, colors.bgBase));
    expect(contrastRatio(colors.textDim, panelSurface)).toBeLessThan(contrastRatio(colors.textMuted, panelSurface));
  });
});
