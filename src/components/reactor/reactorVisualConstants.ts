import type { CSSProperties } from 'react';

// Brief amber flicker overlay whenever anomalies are present -- independent of
// alarmLevel (budget-driven), per Global Constraints. Reuses the existing
// `blink` keyframe (global.css) for the on/off flash cadence. Shared by
// ReactorCore and StormCore so both renderers read the same anomaly signal.
export const ANOMALY_FLICKER_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  borderRadius: '50%',
  background: 'radial-gradient(circle, rgba(245,198,107,.35), transparent 70%)',
  mixBlendMode: 'screen',
  pointerEvents: 'none',
  animation: 'blink 1.6s step-end infinite',
};
