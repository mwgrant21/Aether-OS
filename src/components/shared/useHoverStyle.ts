import { useState, type CSSProperties } from 'react';
import { useColors } from './useColors';

export interface HoverStyleResult {
  style: CSSProperties;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export function useHoverStyle(base: CSSProperties, hover?: CSSProperties): HoverStyleResult {
  const colors = useColors();
  const [isHovering, setIsHovering] = useState(false);
  const resolvedHover = hover ?? { filter: 'brightness(1.1)', borderColor: colors.activeBorder };
  return {
    style: isHovering ? { ...base, ...resolvedHover } : base,
    onMouseEnter: () => setIsHovering(true),
    onMouseLeave: () => setIsHovering(false),
  };
}
