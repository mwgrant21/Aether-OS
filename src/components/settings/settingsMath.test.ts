import { describe, expect, it } from 'vitest';
import { RENDERER_KEY_TO_WORD, rendererKeyToWord } from './settingsMath';

describe('rendererKeyToWord', () => {
  it('maps the internal "classic" key to the terminal word "nebula"', () => {
    expect(rendererKeyToWord('classic')).toBe('nebula');
  });

  it('is an identity mapping for volumetric, warp, and storm', () => {
    expect(rendererKeyToWord('volumetric')).toBe('volumetric');
    expect(rendererKeyToWord('warp')).toBe('warp');
    expect(rendererKeyToWord('storm')).toBe('storm');
  });

  it('RENDERER_KEY_TO_WORD covers exactly the four RendererMode keys', () => {
    expect(Object.keys(RENDERER_KEY_TO_WORD).sort()).toEqual(['classic', 'storm', 'volumetric', 'warp']);
  });
});
