import { useRef, type CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { useReactorCanvas, type ReactorFrame } from './useReactorCanvas';
import { initGL, drawCoreGL, type GLProgram } from './glShader';
import { drawHousing } from './drawHousing';
import { drawConduits } from './drawConduits';
import { drawWarp } from './drawWarp';

export function ReactorCore() {
  const { state } = useAetherStore();
  const glProgramRef = useRef<GLProgram | null>(null);
  const glInitedRef = useRef(false);
  const glFailedRef = useRef(false);

  const { coreRef, glRef, conduitRef } = useReactorCanvas((frame: ReactorFrame) => {
    const renderer = state.cfg.renderer;
    const warp = renderer === 'warp';
    const neb = renderer === 'classic' && !glFailedRef.current;
    const vol = renderer === 'volumetric' && !glFailedRef.current;

    if (vol || neb) {
      if (!glInitedRef.current) {
        glProgramRef.current = initGL(frame.glCanvas);
        glInitedRef.current = true;
        if (!glProgramRef.current) glFailedRef.current = true;
      }
      if (glProgramRef.current) {
        drawCoreGL(glProgramRef.current, {
          t: frame.t,
          surge: frame.surge,
          phase: frame.phase,
          overdrive: frame.overdrive,
          glowFactor: frame.glowFactor,
          burnRate: state.rate,
          soft: neb,
        });
      }
    }
    frame.glCanvas.style.display = vol || neb ? 'block' : 'none';

    if (neb && glProgramRef.current) {
      // frameless nebula: no housing, no conduits — just the storm, fading at its own edge
      frame.coreCtx.setTransform(1, 0, 0, 1, 0, 0);
      frame.coreCtx.clearRect(0, 0, 448, 448);
      frame.conduitCtx.setTransform(1, 0, 0, 1, 0, 0);
      frame.conduitCtx.clearRect(0, 0, 668, 668);
      return;
    }

    if (warp) {
      frame.coreCtx.setTransform(1, 0, 0, 1, 0, 0);
      frame.coreCtx.clearRect(0, 0, 448, 448);
      frame.coreCtx.setTransform(2, 0, 0, 2, 0, 0);
      drawConduits(frame.conduitCtx, { t: frame.t, surge: frame.surge, phase: frame.phase, glowFactor: frame.glowFactor, hubRadius: 48 });
      drawWarp(frame.coreCtx, { t: frame.t, surge: frame.surge, phase: frame.phase, overdrive: frame.overdrive, glowFactor: frame.glowFactor });
      return;
    }

    // VOLUMETRIC (GL healthy) or a WebGL init failure on NEBULA/VOLUMETRIC — housing overlay + conduits
    frame.coreCtx.setTransform(1, 0, 0, 1, 0, 0);
    frame.coreCtx.clearRect(0, 0, 448, 448);
    frame.coreCtx.setTransform(2, 0, 0, 2, 0, 0);
    drawHousing(frame.coreCtx, { t: frame.t, surge: frame.surge, overdrive: frame.overdrive, glowFactor: frame.glowFactor });
    drawConduits(frame.conduitCtx, { t: frame.t, surge: frame.surge, phase: frame.phase, glowFactor: frame.glowFactor, channelWidth: 14 });
  });

  return (
    <>
      <canvas ref={conduitRef} width={668} height={668} style={conduitCanvasStyle} />
      <canvas ref={glRef} width={448} height={448} style={glCanvasStyle} />
      <canvas ref={coreRef} width={448} height={448} style={coreCanvasStyle} />
    </>
  );
}

const conduitCanvasStyle: CSSProperties = { position: 'absolute', inset: 0, width: 334, height: 334 };
const glCanvasStyle: CSSProperties = { position: 'absolute', width: 224, height: 224 };
const coreCanvasStyle: CSSProperties = { position: 'relative', width: 224, height: 224, display: 'block' };
