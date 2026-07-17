import type { CSSProperties } from 'react';
import { useReactorCanvas } from './useReactorCanvas';

export function ReactorCore() {
  const { coreRef, glRef, conduitRef } = useReactorCanvas((frame) => {
    frame.coreCtx.setTransform(1, 0, 0, 1, 0, 0);
    frame.coreCtx.clearRect(0, 0, 448, 448);
    frame.conduitCtx.setTransform(1, 0, 0, 1, 0, 0);
    frame.conduitCtx.clearRect(0, 0, 668, 668);
  });

  return (
    <>
      <canvas ref={conduitRef} width={668} height={668} style={conduitCanvasStyle} />
      <canvas ref={glRef} width={448} height={448} style={{ ...glCanvasStyle, display: 'none' }} />
      <canvas ref={coreRef} width={448} height={448} style={coreCanvasStyle} />
    </>
  );
}

const conduitCanvasStyle: CSSProperties = { position: 'absolute', inset: 0, width: 334, height: 334 };
const glCanvasStyle: CSSProperties = { position: 'absolute', width: 224, height: 224 };
const coreCanvasStyle: CSSProperties = { position: 'relative', width: 224, height: 224, display: 'block' };
