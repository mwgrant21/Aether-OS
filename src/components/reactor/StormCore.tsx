// StormCore.tsx — Aether OS storm nebula core (design handoff "option 4c").
// Fixed 268x268 native box; scale with a wrapper transform to resize, do not
// change the internal numbers — the canvas geometry is pinned to 268.
// Fires a discharge burst whenever the live agent count increases.

import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { useAetherStore } from '../../state/store';
import { createStorm, burnToMode, burnToPulse, type StormHandle } from './aetherStorm';
import { ANOMALY_FLICKER_STYLE } from './reactorVisualConstants';

export const STORM_CORE_NATIVE_SIZE = 268;

const CYAN = '#7ef0ff';
const RIM = 'rgba(126,240,255,.5)';

/** 60-tick containment ring, every 5th tick long */
function ticks(): ReactNode[] {
  const out: ReactNode[] = [];
  for (let i = 0; i < 60; i++) {
    const long = i % 5 === 0;
    out.push(
      <span
        key={i}
        style={{
          position: 'absolute',
          left: '50%',
          top: 0,
          width: long ? 2 : 1,
          height: long ? 13 : 7,
          background: long ? 'rgba(126,240,255,.95)' : 'rgba(70,180,215,.4)',
          transformOrigin: '50% 134px',
          transform: `translateX(-50%) rotate(${i * 6}deg)`,
          display: 'block',
        }}
      />,
    );
  }
  return out;
}

/** broken LCARS arc ring — a 1px ring punched out of a conic gradient */
function arcRing(inset: number, width: number, color: string, animation: string): CSSProperties {
  const mask = `radial-gradient(circle closest-side,transparent 0 calc(100% - ${width}px),#000 calc(100% - ${width}px))`;
  const arcs =
    `conic-gradient(from 0deg,${color} 0 18deg,transparent 18deg 34deg,${color} 34deg 46deg,` +
    `transparent 46deg 96deg,${color} 96deg 132deg,transparent 132deg 150deg,${color} 150deg 158deg,` +
    `transparent 158deg 214deg,${color} 214deg 262deg,transparent 262deg 286deg,${color} 286deg 300deg,` +
    `transparent 300deg 360deg)`;
  return {
    position: 'absolute',
    inset,
    borderRadius: '50%',
    background: arcs,
    maskImage: mask,
    WebkitMaskImage: mask,
    maskRepeat: 'no-repeat',
    WebkitMaskRepeat: 'no-repeat',
    animation,
  } as CSSProperties;
}

interface StormCoreProps {
  filter?: string;
}

export function StormCore({ filter }: StormCoreProps = {}) {
  const { state } = useAetherStore();
  const burnRate = state.rate;
  const agents = state.realAgents.length;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stormRef = useRef<StormHandle | null>(null);
  const modeRef = useRef(1);
  const prevAgents = useRef(agents);

  const mode = burnToMode(burnRate);
  modeRef.current = mode;
  const pulse = useMemo(() => burnToPulse(burnRate), [burnRate]);
  const swirl = (parseFloat(pulse) * 4).toFixed(1) + 's';

  useEffect(() => {
    stormRef.current = createStorm({
      canvas: canvasRef.current,
      kind: 'storm',
      nebula: true,
      getMode: () => modeRef.current,
    });
    return () => stormRef.current?.destroy();
  }, []);

  useEffect(() => {
    if (agents > prevAgents.current) stormRef.current?.strike();
    prevAgents.current = agents;
  }, [agents]);

  return (
    <div style={{ position: 'relative', width: 268, height: 268, display: 'grid', placeItems: 'center', isolation: 'isolate', filter, borderRadius: '50%', overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          width: 268,
          height: 268,
          borderRadius: '50%',
          background: 'radial-gradient(circle,rgba(95,240,255,.26),transparent 66%)',
        }}
      />

      <div style={{ position: 'absolute', inset: 0, animation: 'spin 110s linear infinite' }}>{ticks()}</div>

      <div style={arcRing(18, 1, 'rgba(95,240,255,.48)', 'spin 24s linear infinite')} />
      <div
        style={{
          position: 'absolute',
          inset: 18,
          borderRadius: '50%',
          background: 'conic-gradient(from 0deg,transparent 0 292deg,rgba(191,244,255,.95) 352deg,transparent 360deg)',
          maskImage: 'radial-gradient(circle closest-side,transparent 0 calc(100% - 2px),#000 calc(100% - 2px))',
          WebkitMaskImage: 'radial-gradient(circle closest-side,transparent 0 calc(100% - 2px),#000 calc(100% - 2px))',
          animation: 'spin 3.2s linear infinite',
        } as CSSProperties}
      />
      <div style={arcRing(58, 1, 'rgba(120,235,255,.46)', 'spinRev 15s linear infinite')} />

      {/* orbiting nodes */}
      <div style={{ position: 'absolute', inset: 44, animation: 'spinRev 11s linear infinite' }}>
        <span
          style={{
            position: 'absolute',
            top: -4,
            left: '50%',
            width: 7,
            height: 7,
            marginLeft: -3.5,
            borderRadius: '50%',
            background: CYAN,
            boxShadow: `0 0 12px ${CYAN}`,
          }}
        />
        <span
          style={{
            position: 'absolute',
            bottom: -3,
            left: '50%',
            width: 5,
            height: 5,
            marginLeft: -2.5,
            borderRadius: '50%',
            background: CYAN,
            boxShadow: `0 0 9px ${CYAN}`,
            opacity: 0.6,
          }}
        />
      </div>

      {/* the sphere: 8 stacked layers = volume */}
      <div
        style={{
          position: 'relative',
          width: 142,
          height: 142,
          borderRadius: '50%',
          overflow: 'hidden',
          background: 'radial-gradient(circle at 44% 36%,#c8f7ff 0 3%,#1fc6e4 20%,#0a4c5e 52%,#03212b 80%,#020b11 100%)',
          boxShadow: '0 0 30px rgba(95,240,255,.6),0 0 84px rgba(80,220,255,.34),0 0 170px rgba(60,190,230,.2)',
          animation: `coreBreath var(--pulse-dur, ${pulse}) ease-in-out infinite`,
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: '-30%',
            background:
              'conic-gradient(from 0deg,transparent 0 5%,#7ef0ff 13%,transparent 24%,#17b8d8 42%,transparent 56%,#eafcff 74%,#17b8d8 86%,transparent 96%)',
            filter: 'blur(4px) saturate(1.4)',
            mixBlendMode: 'screen',
            animation: `spin ${swirl} linear infinite`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: '-16%',
            background: 'repeating-conic-gradient(from 0deg,transparent 0 2.5deg,rgba(191,244,255,.4) 2.5deg 3.2deg,transparent 3.2deg 7deg)',
            filter: 'blur(1px)',
            mixBlendMode: 'screen',
            opacity: 0.9,
            animation: 'spin 24s linear infinite',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: '-20%',
            background:
              'radial-gradient(circle at 34% 30%,rgba(255,255,255,.5) 0 2%,transparent 18%),radial-gradient(circle at 70% 60%,rgba(126,240,255,.6) 0 4%,transparent 26%),radial-gradient(circle at 46% 76%,rgba(23,184,216,.75) 0 7%,transparent 32%)',
            mixBlendMode: 'screen',
            opacity: 0.8,
            animation: 'spinRev 15s linear infinite, hueDrift 9s ease-in-out infinite',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: 'radial-gradient(rgba(255,255,255,.1) .5px,transparent .6px)',
            backgroundSize: '3.5px 3.5px',
            mixBlendMode: 'screen',
            opacity: 0.55,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: '24%',
            top: '16%',
            width: '15%',
            height: '11%',
            borderRadius: '50%',
            background: 'radial-gradient(circle,#fff,rgba(255,255,255,.4) 48%,transparent 74%)',
            filter: 'blur(1px)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            background:
              'radial-gradient(circle at 42% 36%,transparent 0 20%,rgba(2,10,16,.34) 52%,rgba(2,10,16,.7) 74%,rgba(2,10,16,.93) 90%,rgba(2,10,16,1) 100%)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            boxShadow: `inset 2px 3px 14px ${RIM}, inset -6px -8px 22px rgba(2,10,16,.75)`,
          }}
        />
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `1px solid ${RIM}`, opacity: 0.55 }} />
      </div>

      {/* discharge + nebula cloud */}
      <canvas ref={canvasRef} style={{ position: 'absolute', left: 0, top: 0, width: 268, height: 268, pointerEvents: 'none' }} />

      {state.anomalies.length > 0 && <div style={ANOMALY_FLICKER_STYLE} />}
    </div>
  );
}
