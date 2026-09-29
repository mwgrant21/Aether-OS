import { useState, type AriaAttributes, type CSSProperties, type FocusEvent, type ReactNode } from 'react';
import { useHoverStyle } from './useHoverStyle';
import { useColors } from './useColors';

interface ButtonProps {
  onClick: () => void;
  style: CSSProperties;
  hoverStyle?: CSSProperties;
  title?: string;
  disabled?: boolean;
  'aria-label'?: string;
  /** Toggle state for a two-state or one-of-N control (mode pills, range chips). */
  'aria-pressed'?: AriaAttributes['aria-pressed'];
  /** The current item in a set, e.g. `"page"` on the active nav item. */
  'aria-current'?: AriaAttributes['aria-current'];
  /** Open state of the panel this button discloses (top-bar dropdowns). */
  'aria-expanded'?: AriaAttributes['aria-expanded'];
  /** id of the element this button controls, set while it is rendered. */
  'aria-controls'?: string;
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

export function Button({
  onClick,
  style,
  hoverStyle,
  title,
  disabled,
  'aria-label': ariaLabel,
  'aria-pressed': ariaPressed,
  'aria-current': ariaCurrent,
  'aria-expanded': ariaExpanded,
  'aria-controls': ariaControls,
  children,
}: ButtonProps) {
  const colors = useColors();
  // Tracks keyboard focus only (DESIGN.md's ring is a keyboard-focus affordance,
  // not a mouse-click one): gated on the native :focus-visible heuristic so a
  // mouse click that focuses the button never shows the ring.
  const [isFocusVisible, setIsFocusVisible] = useState(false);
  const mergedStyle = { ...RESET_STYLE, ...withoutUndefined(style) };
  const mergedHoverStyle = hoverStyle && { ...mergedStyle, ...withoutUndefined(hoverStyle) };
  const { style: hoveredStyle, onMouseEnter, onMouseLeave } = useHoverStyle(mergedStyle, mergedHoverStyle, isFocusVisible);
  const focusRingStyle: CSSProperties = isFocusVisible ? { outline: `2px solid ${colors.textPrimary}`, outlineOffset: 3 } : {};

  function onFocus(e: FocusEvent<HTMLButtonElement>) {
    if (e.currentTarget.matches(':focus-visible')) setIsFocusVisible(true);
  }
  function onBlur() {
    setIsFocusVisible(false);
  }

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      style={{ ...hoveredStyle, ...focusRingStyle }}
      title={title}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      aria-current={ariaCurrent}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
    >
      {children}
    </button>
  );
}
