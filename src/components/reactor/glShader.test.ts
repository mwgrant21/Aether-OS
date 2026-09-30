import { describe, it, expect, vi, afterEach } from 'vitest';
import { initGL } from './glShader';

describe('initGL context-loss flag (issue #22)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sets data-gl-lost on webglcontextlost and clears it on restore, without preventDefault', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const el = document.createElement('canvas');
    initGL(el);
    const lost = new Event('webglcontextlost', { cancelable: true });
    el.dispatchEvent(lost);
    expect(el.dataset.glLost).toBe('1');
    expect(el.hasAttribute('data-gl-lost')).toBe(true);
    expect(lost.defaultPrevented).toBe(false);
    expect(err).toHaveBeenCalledWith('[diag] webgl context lost');
    el.dispatchEvent(new Event('webglcontextrestored'));
    expect(el.hasAttribute('data-gl-lost')).toBe(false);
  });
});
