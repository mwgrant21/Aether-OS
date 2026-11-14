import { useEffect, useRef } from 'react';
import { Button } from '../components/shared/Button';
import { useColors } from '../components/shared/useColors';
import { fonts, radii } from '../styles/tokens';

interface ConfirmPopupProps {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Focus the confirm button so Enter confirms. Default false: Cancel holds the focus. */
  confirmOnEnter?: boolean;
}

/**
 * Small inline confirm dialog. Esc cancels. By default Cancel holds the focus (the safe default);
 * with `confirmOnEnter` the confirm button holds it instead, so Enter confirms, and a held
 * (auto-repeating) Enter is ignored so the keypress that opened the popup cannot confirm it.
 */
export function ConfirmPopup({ message, confirmLabel, onConfirm, onCancel, confirmOnEnter = false }: ConfirmPopupProps) {
  const colors = useColors();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const buttonsRef = useRef<HTMLSpanElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    // The confirm control is the shared Button (no ref forwarding): it is the wrapper's last child.
    const target = confirmOnEnter ? (buttonsRef.current?.lastElementChild as HTMLElement | null | undefined) : cancelRef.current;
    target?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancelRef.current();
    };
    const onRepeatEnter = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && e.repeat) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    if (confirmOnEnter) document.addEventListener('keydown', onRepeatEnter, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', onRepeatEnter, true);
    };
  }, [confirmOnEnter]);

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
      <span ref={buttonsRef} style={{ display: 'flex', gap: 8 }}>
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
