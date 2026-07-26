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

// Callers commonly build style objects like `{ background: on ? 'x' : undefined }` —
// an explicit `undefined` value still overwrites RESET_STYLE's key when spread, which
// makes React omit the inline property entirely and fall back to the browser's default
// <button> chrome (a jarring light/white box). Stripping undefined keys before merging
// keeps RESET_STYLE's value in that case.
function withoutUndefined(style: CSSProperties): CSSProperties {
  return Object.fromEntries(Object.entries(style).filter(([, value]) => value !== undefined)) as CSSProperties;
}

export function Button({ onClick, style, hoverStyle, title, disabled, children }: ButtonProps) {
  const mergedStyle = { ...RESET_STYLE, ...withoutUndefined(style) };
  const mergedHoverStyle = hoverStyle && { ...mergedStyle, ...withoutUndefined(hoverStyle) };
  const { style: hoveredStyle, onMouseEnter, onMouseLeave } = useHoverStyle(mergedStyle, mergedHoverStyle);
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
