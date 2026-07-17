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
