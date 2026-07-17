import { useEffect, useRef } from 'react';
import { useAetherStore } from '../../state/store';
import { advancePhase, computePulseDuration, computeSurge, computeThemeFilter } from './reactorMath';

export interface ReactorFrame {
  now: number;
  t: number;
  dt: number;
  phase: number;
  surge: number;
  overdrive: boolean;
  glowFactor: number;
  coreCtx: CanvasRenderingContext2D;
  glCanvas: HTMLCanvasElement;
  conduitCtx: CanvasRenderingContext2D;
}

export function useReactorCanvas(draw: (frame: ReactorFrame) => void) {
  const { state } = useAetherStore();
  const coreRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const conduitRef = useRef<HTMLCanvasElement>(null);

  const rafRef = useRef<number>();
  const lastDrawRef = useRef(0);
  const lastTRef = useRef<number>();
  const phaseRef = useRef(0);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const dur = computePulseDuration(state.rate, state.cfg.pulseMode, state.alarmLevel);
    document.documentElement.style.setProperty('--pulse-dur', `${dur.toFixed(2)}s`);
  }, [state.rate, state.cfg.pulseMode, state.alarmLevel]);

  useEffect(() => {
    let cancelled = false;

    function runFrame(now: number) {
      if (cancelled) return;
      const s = stateRef.current;
      const coreEl = coreRef.current;
      const glEl = glRef.current;
      const conduitEl = conduitRef.current;
      if (coreEl && glEl && conduitEl) {
        const dur = computePulseDuration(s.rate, s.cfg.pulseMode, s.alarmLevel);
        const t = now / 1000;
        const dt = Math.min(0.1, t - (lastTRef.current ?? t));
        lastTRef.current = t;
        phaseRef.current = advancePhase(phaseRef.current, dt, dur);
        const phase = phaseRef.current;
        const surge = computeSurge(phase);
        const overdrive = s.agents.length >= 7;
        const glowFactor = (s.cfg.glow == null ? 70 : s.cfg.glow) / 70;
        const themeFilter = computeThemeFilter(s.cfg.theme, s.alarmLevel, s.cfg.glowFx);
        [coreEl, glEl, conduitEl].forEach((el) => {
          if (el.style.filter !== themeFilter) el.style.filter = themeFilter;
        });
        const coreCtx = coreEl.getContext('2d');
        const conduitCtx = conduitEl.getContext('2d');
        if (coreCtx && conduitCtx) {
          drawRef.current({ now, t, dt, phase, surge, overdrive, glowFactor, coreCtx, glCanvas: glEl, conduitCtx });
        }
      }
      lastDrawRef.current = Date.now();
      rafRef.current = requestAnimationFrame(runFrame);
    }

    rafRef.current = requestAnimationFrame(runFrame);

    // Stall watchdog: if the rAF loop hasn't drawn in 2s (backgrounded/throttled tab),
    // force one draw and restart the loop — mirrors the source's tick-driven watchdog.
    const watchdog = setInterval(() => {
      if (Date.now() - lastDrawRef.current > 2000) {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        runFrame(performance.now());
      }
    }, 900);

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      clearInterval(watchdog);
    };
  }, []);

  return { coreRef, glRef, conduitRef };
}
