import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { motion } from '../../styles/tokens';
import { useReducedMotion } from '../shared/useReducedMotion';

type Phase = 'steady' | 'entering' | 'leaving';

/** How long a leaving digest stays mounted while it fades: motion.duration.slow, in ms. */
export const DIGEST_EXIT_MS = parseFloat(motion.duration.slow) * 1000;

/**
 * Wraps one dashboard digest. A digest is drawn only while it has data;
 * gaining data brings it in (opacity + a short rise), losing data fades it
 * out before it unmounts. The fade animates opacity/transform only. A leaving
 * slot is pinned at its measured top/height and taken out of the flex flow,
 * so siblings reflow at once. Under reduced motion it just appears and disappears.
 */
export function DigestSlot({ present, children }: { present: boolean; children: ReactNode }) {
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const [mounted, setMounted] = useState(present);
  const elRef = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<{ top: number; height: number } | null>(null);
  const [phase, setPhase] = useState<Phase>('steady');
  // Compare with the last value rather than skipping the first run: StrictMode
  // re-runs mount effects, and a first-run flag would animate a panel that
  // was there from the start.
  const prevPresent = useRef(present);

  useEffect(() => {
    if (prevPresent.current === present) return;
    prevPresent.current = present;
    if (present) {
      setMounted(true);
      setGeometry(null);
      setPhase(reducedRef.current ? 'steady' : 'entering');
      return;
    }
    if (reducedRef.current) {
      setMounted(false);
      setPhase('steady');
      return;
    }
    const el = elRef.current;
    setGeometry(el ? { top: el.offsetTop, height: el.offsetHeight } : null);
    setPhase('leaving');
    // Cleared by the next run if the digest regains data mid-exit.
    const t = setTimeout(() => {
      setMounted(false);
      setGeometry(null);
      setPhase('steady');
    }, DIGEST_EXIT_MS);
    return () => clearTimeout(t);
  }, [present]);

  if (!mounted) return null;
  return (
    <div ref={elRef} data-testid="digest-slot" data-phase={phase} aria-hidden={phase === 'leaving' ? true : undefined} style={slotStyle(phase, geometry)}>
      {children}
    </div>
  );
}

const EASE = motion.easing.decelerate;
function slotStyle(phase: Phase, geometry: { top: number; height: number } | null): CSSProperties {
  const base: CSSProperties = { flex: '1 1 0', minHeight: 0, display: 'grid', gridTemplateRows: 'minmax(0, 1fr)' };
  if (phase === 'entering') return { ...base, animation: `digestEnter ${motion.duration.slow} ${EASE} both` };
  if (phase === 'leaving') {
    // Out of flex flow (absolute in the positioned column) so siblings reflow
    // at once while the ghost fades in place at its own size.
    return {
      ...base,
      position: 'absolute',
      left: 0,
      right: 0,
      ...(geometry ?? {}),
      opacity: 0,
      transform: 'translateY(8px)',
      pointerEvents: 'none',
      transition: `opacity ${motion.duration.slow} ${EASE}, transform ${motion.duration.slow} ${EASE}`,
    };
  }
  return base;
}
