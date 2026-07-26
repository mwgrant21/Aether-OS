export const DESIGN_FRAME_WIDTH = 1536;
export const DESIGN_FRAME_HEIGHT = 1024;

export interface ComputeFrameScaleOptions {
  allowUpscale?: boolean;
}

export function computeFrameScale(
  viewportW: number,
  viewportH: number,
  frameW: number = DESIGN_FRAME_WIDTH,
  frameH: number = DESIGN_FRAME_HEIGHT,
  options: ComputeFrameScaleOptions = {},
): number {
  if (viewportW <= 0 || viewportH <= 0 || frameW <= 0 || frameH <= 0) {
    return 1;
  }

  const scale = Math.min(viewportW / frameW, viewportH / frameH);

  if (options.allowUpscale) {
    return scale;
  }

  return Math.min(scale, 1);
}
