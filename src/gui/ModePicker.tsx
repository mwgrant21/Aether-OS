import { useEffect, useRef, useState } from 'react';
import { GUI_PERMISSION_MODES, type GuiPermissionMode } from '../../electron/gui/guiTypes';
import { Button } from '../components/shared/Button';
import { useColors } from '../components/shared/useColors';
import { fonts, radii } from '../styles/tokens';

export const MODE_LABELS: Record<GuiPermissionMode, string> = {
  manual: 'Manual',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto',
};

interface ModePickerProps {
  mode: GuiPermissionMode;
  disabled: boolean;
  /** Tooltip while disabled (why). */
  hint?: string;
  onSelect: (mode: GuiPermissionMode) => void;
}

/** Composer-left permission-mode dropdown: `● Auto ▾`. Presentational; the parent decides what a selection does. */
export function ModePicker({ mode, disabled, hint, onSelect }: ModePickerProps) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const isOpen = open && !disabled;

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [isOpen]);

  const tone = (m: GuiPermissionMode): string => (m === 'auto' ? colors.warn : colors.textSecondary);

  return (
    <div ref={rootRef} style={{ position: 'relative', flex: 'none' }}>
      <Button
        onClick={() => setOpen((v) => !v)}
        title={disabled ? hint : undefined}
        aria-disabled={disabled}
        aria-expanded={isOpen}
        aria-label={`Permission mode: ${MODE_LABELS[mode]}`}
        style={{
          padding: '6px 10px',
          borderRadius: radii.chip,
          font: `600 14px/1.2 ${fonts.ui}`,
          color: tone(mode),
          border: `1px solid ${colors.chromeBorder}`,
          background: 'transparent',
          opacity: disabled ? 0.6 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {`● ${MODE_LABELS[mode]} ▾`}
      </Button>
      {isOpen && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            marginBottom: 6,
            minWidth: 150,
            padding: 4,
            borderRadius: radii.chip,
            border: `1px solid ${colors.chromeBorder}`,
            background: colors.bgBase,
            zIndex: 10,
          }}
        >
          {GUI_PERMISSION_MODES.map((m) => (
            <Button
              key={m}
              onClick={() => {
                setOpen(false);
                onSelect(m);
              }}
              aria-current={m === mode ? 'true' : undefined}
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 10px',
                borderRadius: radii.chip,
                font: `${m === mode ? 700 : 500} 14px/1.2 ${fonts.ui}`,
                color: m === mode ? colors.textPrimary : tone(m),
                background: m === mode ? colors.accentCyanSoft : 'transparent',
              }}
            >
              <span role="menuitem">{`● ${MODE_LABELS[m]}`}</span>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
