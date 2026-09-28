import { useState, type CSSProperties } from 'react';
import { useColors } from './useColors';

export interface HoverStyleResult {
  style: CSSProperties;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

// `forceActive` applies the hover ("lit") treatment without a real mouse hover --
// it's how a keyboard-focused element gets the same lit look a hovered one gets
// (DESIGN.md's Buttons > Keyboard focus: "on top of whatever glow the state
// already has"), driven by the caller's own focus-visible state rather than a
// CSS pseudo-class this codebase's inline styles have no way to express.
export function useHoverStyle(base: CSSProperties, hover?: CSSProperties, forceActive = false): HoverStyleResult {
  const colors = useColors();
  const [isHovering, setIsHovering] = useState(false);
  const resolvedHover = hover ?? { filter: 'brightness(1.1)', border: `1px solid ${colors.activeBorder}` };
  const active = isHovering || forceActive;
  return {
    style: active ? { ...base, ...resolvedHover } : base,
    onMouseEnter: () => setIsHovering(true),
    onMouseLeave: () => setIsHovering(false),
  };
}
