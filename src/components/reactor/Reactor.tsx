// Reactor.tsx — picks the active core visual based on state.cfg.renderer.
// 'storm' renders the CSS+canvas storm-nebula core (design handoff "option 4c");
// everything else renders the existing multi-canvas classic/volumetric/warp system.
//
// warp5d (WarpCore) is stripped out for now -- it kept producing a visible
// compositor seam (filter/isolate rasterization bleeding past the rotated-arm
// geometry) that resisted several padding/clipping attempts, most recently
// oversizing itself out of the sidebar slot. See git history for WarpCore.tsx
// and warp-core.css if picking this back up.

import { useAetherStore } from '../../state/store';
import type { RendererMode } from '../../state/types';
import { ReactorCore } from './ReactorCore';
import { StormCore, STORM_CORE_NATIVE_SIZE } from './StormCore';
import { computeThemeFilter, computeDispatchIntensity, computeModelHueShift, dominantModel } from './reactorMath';

export const REACTOR_CORE_NATIVE_SIZE = 334;

export function reactorNativeSize(renderer: RendererMode): [width: number, height: number] {
  if (renderer === 'storm') return [STORM_CORE_NATIVE_SIZE, STORM_CORE_NATIVE_SIZE];
  return [REACTOR_CORE_NATIVE_SIZE, REACTOR_CORE_NATIVE_SIZE];
}

export function Reactor() {
  const { state } = useAetherStore();
  if (state.cfg.renderer === 'storm') {
    // StormCore paints its own colors in CSS rather than reading state.cfg.theme
    // (unlike ReactorCore's canvases, whose color comes from computeThemeFilter applied
    // to the canvas element per-frame) — apply the same hue-rotate filter directly on its
    // own isolated root (not an extra wrapper div) so filter and `isolation: isolate` sit on
    // the same element; splitting them across two elements let blend-mode layers (plasma
    // sweep, filaments, blobs) bleed past the component's box on some compositors.
    const { overload } = computeDispatchIntensity(state.realAgents.length);
    const modelHueShift = computeModelHueShift(dominantModel(state.realAgents));
    const filter = computeThemeFilter(state.cfg.theme, state.alarmLevel, state.cfg.glowFx, overload, modelHueShift);
    return <StormCore filter={filter} />;
  }
  return <ReactorCore />;
}
