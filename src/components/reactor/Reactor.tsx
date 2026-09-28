// Reactor.tsx — picks the active core visual based on state.cfg.renderer.
// 'storm' renders the CSS+canvas storm-nebula core (design handoff "option 4c");
// everything else renders the existing multi-canvas classic/volumetric/warp system.
//
// warp5d (WarpCore) is stripped out for now -- it kept producing a visible
// compositor seam (filter/isolate rasterization bleeding past the rotated-arm
// geometry) that resisted several padding/clipping attempts, most recently
// oversizing itself out of the sidebar slot. See git history for WarpCore.tsx
// and warp-core.css if picking this back up.

import { useEffect, useRef, useState } from 'react';
import { useAetherStore } from '../../state/store';
import type { RendererMode } from '../../state/types';
import { motion } from '../../styles/tokens';
import { isSessionLive } from '../dashboard/dashboardMath';
import { ReactorCore } from './ReactorCore';
import { StormCore, STORM_CORE_NATIVE_SIZE } from './StormCore';
import { computeThemeFilter, computeDispatchIntensity, computeIdleDimFilter, stepIdleLevel } from './reactorMath';

export const REACTOR_CORE_NATIVE_SIZE = 334;

export function reactorNativeSize(renderer: RendererMode): [width: number, height: number] {
  if (renderer === 'storm') return [STORM_CORE_NATIVE_SIZE, STORM_CORE_NATIVE_SIZE];
  return [REACTOR_CORE_NATIVE_SIZE, REACTOR_CORE_NATIVE_SIZE];
}

const IDLE_FADE_MS = parseFloat(motion.duration.slow) * 1000;

// Tweens 0 (live) <-> 1 (idle) over IDLE_FADE_MS so power-up and power-down are
// visible. StormCore's root carries no CSS transition and is off-limits here, so
// the fade is driven from this side through the filter string it already accepts.
// Starts AT the current target, so mounting never plays a fade.
function useIdleLevel(live: boolean): number {
  const target = live ? 0 : 1;
  const [level, setLevel] = useState(target);
  const levelRef = useRef(target);
  useEffect(() => {
    if (levelRef.current === target) return;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      levelRef.current = stepIdleLevel(levelRef.current, target, now - last, IDLE_FADE_MS);
      last = now;
      setLevel(levelRef.current);
      if (levelRef.current !== target) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return level;
}

export function Reactor() {
  const { state } = useAetherStore();
  const idleLevel = useIdleLevel(isSessionLive(state, Date.now()));
  if (state.cfg.renderer === 'storm') {
    // StormCore paints its own colors in CSS rather than reading state.cfg.theme
    // (unlike ReactorCore's canvases, whose color comes from computeThemeFilter applied
    // to the canvas element per-frame) — apply the same hue-rotate filter directly on its
    // own isolated root (not an extra wrapper div) so filter and `isolation: isolate` sit on
    // the same element; splitting them across two elements let blend-mode layers (plasma
    // sweep, filaments, blobs) bleed past the component's box on some compositors.
    const { overload } = computeDispatchIntensity(state.realAgents.length);
    // The idle suffix is '' at idleLevel 0, so a live reactor gets exactly the
    // theme filter it always has.
    const filter = computeThemeFilter(state.cfg.theme, state.alarmLevel, state.cfg.glowFx, overload) + computeIdleDimFilter(idleLevel);
    return <StormCore filter={filter} />;
  }
  // The classic renderer sets its own per-frame canvas filter inside
  // useReactorCanvas and is not dimmed on idle.
  return <ReactorCore />;
}
