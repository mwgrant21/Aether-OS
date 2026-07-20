import type { RendererMode } from '../../state/types';

export const RENDERER_KEY_TO_WORD: Record<RendererMode, string> = {
  classic: 'nebula',
  volumetric: 'volumetric',
  warp: 'warp',
};

export function rendererKeyToWord(renderer: RendererMode): string {
  return RENDERER_KEY_TO_WORD[renderer];
}
