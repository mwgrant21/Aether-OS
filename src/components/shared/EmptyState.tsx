import type { CSSProperties, ReactNode } from 'react';
import { fonts, glows, radii, type ColorPalette } from '../../styles/tokens';
import { useColors } from './useColors';
import { Button } from './Button';

interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

// At most one action: a label + handler rendered as the Secondary button, or a
// ready-made control in `actionSlot` (the Agents roster's OpenTerminalButton,
// which carries its own desktop-app check).
type EmptyStateProps =
  | { message: string; action?: EmptyStateAction; actionSlot?: never }
  | { message: string; action?: never; actionSlot: ReactNode };

// The one empty-state voice across views: a single plain sentence saying what
// will appear and where it comes from, plus at most one next action. Flat at
// rest (Glow-Is-State): only the action lights, and only on hover or keyboard
// focus.
export function EmptyState({ message, action, actionSlot }: EmptyStateProps) {
  const colors = useColors();
  const hasAction = action !== undefined || actionSlot !== undefined;
  return (
    <div data-empty-state="true" style={hasAction ? rootWithActionStyle : rootStyle}>
      <p style={messageStyle(colors)}>{message}</p>
      {action && (
        <Button onClick={action.onClick} style={actionStyle(colors)} hoverStyle={actionHoverStyle(colors)}>
          {action.label}
        </Button>
      )}
      {actionSlot}
    </div>
  );
}

// Most empty states sit inside an `overflow: auto` list, which clips at its
// padding edge. The keyboard focus ring reaches 5px past the action (2px
// outline + 3px offset, DESIGN.md), so a root that holds an action reserves
// that much on every side and the ring is never clipped, whatever container
// holds it. A message-only root has nothing focusable, so it takes no padding
// and its sentence sits flush with the panel heading above it.
export const FOCUS_RING_CLEARANCE = 6;
const rootStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 10,
};
const rootWithActionStyle: CSSProperties = { ...rootStyle, padding: FOCUS_RING_CLEARANCE };

function messageStyle(colors: ColorPalette): CSSProperties {
  return { margin: 0, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textMuted, maxWidth: '38ch', textWrap: 'pretty' } as CSSProperties;
}

// DESIGN.md Buttons > Secondary: inset surface, Reactor Cyan label, Active
// Edge border; hover takes a solid cyan edge and the active glow.
function actionStyle(colors: ColorPalette): CSSProperties {
  return {
    font: `600 11px/1 ${fonts.ui}`,
    letterSpacing: 2,
    color: colors.accentCyan,
    background: colors.panelInset,
    border: `1px solid ${colors.activeBorder}`,
    borderRadius: radii.tile,
    padding: '7px 12px',
  };
}

function actionHoverStyle(colors: ColorPalette): CSSProperties {
  return { border: `1px solid ${colors.accentCyan}`, boxShadow: `${glows.active}, ${glows.innerCharge}` };
}
