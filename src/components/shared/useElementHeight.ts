import { useCallback, useRef, useState } from 'react';

// Callback-ref based hook that reports a mounted element's live rendered
// height. Used instead of a hardcoded pixel guess when stacking fixed-position
// cards -- see PermissionCardStack.tsx. Height updates in real time as the
// element's content changes shape (e.g. an editable field or a reason box
// opening/closing) via ResizeObserver, and resets to null when the element
// unmounts (React calls a callback ref with null on unmount automatically).
export function useElementHeight(): [(node: HTMLElement | null) => void, number | null] {
  const [height, setHeight] = useState<number | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const setNode = useCallback((node: HTMLElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!node) {
      setHeight(null);
      return;
    }
    setHeight(node.getBoundingClientRect().height);
    // jsdom (this project's Vitest environment) has no ResizeObserver by
    // default -- guard so tests without a polyfill still get the initial
    // getBoundingClientRect() height above, just without live updates.
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setHeight(entry.contentRect.height);
        }
      });
      observer.observe(node);
      observerRef.current = observer;
    }
  }, []);

  return [setNode, height];
}
