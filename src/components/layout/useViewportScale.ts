import { useEffect, useState } from 'react';
import { computeFrameScale } from './frameScale';

export function useViewportScale(): number {
  const [scale, setScale] = useState(() =>
    typeof window === 'undefined' ? 1 : computeFrameScale(window.innerWidth, window.innerHeight),
  );

  useEffect(() => {
    const updateScale = () => {
      setScale(computeFrameScale(window.innerWidth, window.innerHeight));
    };

    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, []);

  return scale;
}
