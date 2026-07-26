import { useState, type CSSProperties } from 'react';
import { colors } from '../../styles/tokens';

const DEFAULT_HOVER: CSSProperties = {
  filter: 'brightness(1.1)',
  borderColor: colors.activeBorder,
};

export interface HoverStyleResult {
  style: CSSProperties;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export function useHoverStyle(base: CSSProperties, hover: CSSProperties = DEFAULT_HOVER): HoverStyleResult {
  const [isHovering, setIsHovering] = useState(false);
  return {
    style: isHovering ? { ...base, ...hover } : base,
    onMouseEnter: () => setIsHovering(true),
    onMouseLeave: () => setIsHovering(false),
  };
}
