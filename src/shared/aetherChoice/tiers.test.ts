import { describe, expect, it } from 'vitest';
import { GLOW, ROLE_COLORS, TIER_TABLE } from './tiers';
import { LAUNCH_EFFORTS, MANUAL_ONLY_EFFORTS, MODEL_ALIASES } from './types';

describe('AetherChoice tier table', () => {
  it('matches the locked bars and hex values', () => {
    expect(TIER_TABLE.haiku).toMatchObject({ hex: '#dfee5a', bars: 1 });
    expect(TIER_TABLE.sonnet).toMatchObject({ hex: '#5f86ff', bars: 2 });
    expect(TIER_TABLE.opus).toMatchObject({ hex: '#c98cff', bars: 3 });
    expect(TIER_TABLE.fable).toMatchObject({ hex: '#d5dde6', bars: 4 });
    expect(TIER_TABLE.design.hex).toBe('#ff8fd0');
  });

  it('labels each tier with its model name', () => {
    for (const [id, e] of Object.entries(TIER_TABLE)) expect(e.label).toBe(id);
  });

  it('makes fable the only filled tag', () => {
    const filled = Object.entries(TIER_TABLE).filter(([, e]) => e.filled).map(([id]) => id);
    expect(filled).toEqual(['fable']);
  });

  it('gives design a sparkle glyph and no bars', () => {
    expect(TIER_TABLE.design).toMatchObject({ glyph: 'sparkle', bars: 0 });
  });

  it('keeps amber and red distinct, with the locked glow', () => {
    expect(ROLE_COLORS.needsYou).toBe('#ffb454');
    expect(ROLE_COLORS.failed).toBe('#ff5c57');
    expect(ROLE_COLORS.needsYou).not.toBe(ROLE_COLORS.failed);
    expect(GLOW.amber).toMatchObject({ blurPx: 10, alpha: 0.3, pulse: false });
    expect(GLOW.red).toMatchObject({ blurPx: 18, alpha: 0.85, pulseSeconds: 2.4 });
  });

  it('LAUNCH_EFFORTS is the five CLI values with no ultra', () => {
    expect([...LAUNCH_EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect((LAUNCH_EFFORTS as readonly string[]).includes('ultra')).toBe(false);
  });

  it('MANUAL_ONLY_EFFORTS is exactly xhigh and max', () => {
    expect([...MANUAL_ONLY_EFFORTS]).toEqual(['xhigh', 'max']);
  });

  it('keeps fable out of the launchable models', () => {
    expect([...MODEL_ALIASES]).toEqual(['haiku', 'sonnet', 'opus']);
  });
});
