import type { CSSProperties, ReactNode } from 'react';
import { useHoverStyle } from './useHoverStyle';

interface ButtonProps {
  onClick: () => void;
  style: CSSProperties;
  hoverStyle?: CSSProperties;
  title?: string;
  disabled?: boolean;
  children: ReactNode;
}

const RESET_STYLE: CSSProperties = {
  background: 'none',
  border: 'none',
  font: 'inherit',
  color: 'inherit',
  padding: 0,
  margin: 0,
  cursor: 'pointer',
  textAlign: 'inherit',
};

export function Button({ onClick, style, hoverStyle, title, disabled, children }: ButtonProps) {
  const { style: hoveredStyle, onMouseEnter, onMouseLeave } = useHoverStyle({ ...RESET_STYLE, ...style }, hoverStyle && { ...RESET_STYLE, ...style, ...hoverStyle });
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={hoveredStyle}
      title={title}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
