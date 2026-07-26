import { describe, expect, it } from 'vitest';
import { computeFrameScale } from './frameScale';

describe('computeFrameScale', () => {
  it('returns 1 for an exact-fit viewport', () => {
    expect(computeFrameScale(1536, 1024)).toBe(1);
  });

  it('is limited by height when the viewport is wider-than-tall relative to the frame', () => {
    // frame aspect is 1.5; a much wider viewport should be capped by height
    const scale = computeFrameScale(3000, 512);
    expect(scale).toBeCloseTo(512 / 1024);
  });

  it('is limited by width when the viewport is taller-than-wide relative to the frame', () => {
    const scale = computeFrameScale(768, 2000);
    expect(scale).toBeCloseTo(768 / 1536);
  });

  it('returns 1 for degenerate/zero viewport inputs', () => {
    expect(computeFrameScale(0, 1024)).toBe(1);
    expect(computeFrameScale(1536, 0)).toBe(1);
    expect(computeFrameScale(-100, 1024)).toBe(1);
    expect(computeFrameScale(1536, -1)).toBe(1);
  });

  it('clamps upscale off by default', () => {
    expect(computeFrameScale(3072, 2048)).toBe(1);
  });

  it('allows upscale when allowUpscale is set', () => {
    const scale = computeFrameScale(3072, 2048, 1536, 1024, { allowUpscale: true });
    expect(scale).toBe(2);
  });
});
