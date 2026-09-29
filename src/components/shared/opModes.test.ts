import { describe, expect, it } from 'vitest';
import { colors, glows } from '../../styles/tokens';
import { opModeOnSkin } from './opModes';

describe('opModeOnSkin', () => {
  it('lights AUTO amber from the warn tokens with the needs-you glow', () => {
    const skin = opModeOnSkin(colors, 'AUTO');
    expect(skin.color).toBe(colors.inkOnAmber);
    expect(skin.background).toBe(`linear-gradient(180deg,${colors.warn},${colors.warnDeep})`);
    expect(skin.boxShadow).toBe(glows.needsYou);
  });

  it('lights the other modes cyan with the active glow', () => {
    for (const key of ['PLAN', 'EDITS'] as const) {
      const skin = opModeOnSkin(colors, key);
      expect(skin.color).toBe(colors.inkOnCyan);
      expect(skin.background).toBe(`linear-gradient(180deg,${colors.accentCyan},${colors.accentCyanDeep})`);
      expect(skin.boxShadow).toBe(glows.active);
    }
  });
});
