import { useEffect, useRef } from 'react';
import { Button } from '../components/shared/Button';
import { useColors } from '../components/shared/useColors';
import { fonts, radii } from '../styles/tokens';

interface ConfirmPopupProps {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Small inline confirm dialog. Cancel holds the focus (the safe default) and Esc cancels. */
export function ConfirmPopup({ message, confirmLabel, onConfirm, onCancel }: ConfirmPopupProps) {
  const colors = useColors();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancelRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const btn = {
    padding: '4px 12px',
    borderRadius: radii.chip,
    font: `600 13px/1.2 ${fonts.ui}`,
    color: colors.textPrimary,
    border: `1px solid ${colors.chromeBorder}`,
    background: 'transparent',
  } as const;
  return (
    <div
      role="dialog"
      aria-label={message}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        margin: '0 24px',
        padding: '8px 12px',
        borderRadius: radii.chip,
        border: `1px solid ${colors.chromeBorder}`,
        background: colors.panelInset,
        color: colors.textBody,
        font: `500 14px/1.4 ${fonts.ui}`,
      }}
    >
      <span>{message}</span>
      <span style={{ display: 'flex', gap: 8 }}>
        <button ref={cancelRef} type="button" onClick={onCancel} style={{ ...btn, cursor: 'pointer' }}>
          Cancel
        </button>
        <Button onClick={onConfirm} style={{ ...btn, background: colors.accentCyanSoft, border: `1px solid ${colors.activeBorder}` }}>
          {confirmLabel}
        </Button>
      </span>
    </div>
  );
}
