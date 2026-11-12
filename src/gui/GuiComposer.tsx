import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '../components/shared/Button';
import { useColors } from '../components/shared/useColors';
import { fonts, radii } from '../styles/tokens';

interface GuiComposerProps {
  disabled: boolean;
  placeholder?: string;
  /** Resolve true to clear the text; false keeps it. */
  onSubmit: (text: string) => Promise<boolean> | boolean;
  /** Reserved slot left of Send (a later "Auto" pill / model picker mounts here). */
  leading?: ReactNode;
}

const MAX_HEIGHT = 240;

export function GuiComposer({ disabled, placeholder, onSubmit, leading }: GuiComposerProps) {
  const colors = useColors();
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const canSend = !disabled && text.trim() !== '';

  const submit = async (): Promise<void> => {
    if (disabled || busy.current || text.trim() === '') return;
    busy.current = true;
    try {
      if ((await onSubmit(text)) === true) setText('');
    } finally {
      busy.current = false;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void submit();
  };

  return (
    <div style={{ width: '100%', maxWidth: 760, margin: '0 auto', boxSizing: 'border-box', padding: '8px 16px 16px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          padding: 8,
          borderRadius: radii.chip,
          border: `1px solid ${colors.chromeBorder}`,
          background: colors.panelInset,
          opacity: disabled ? 0.7 : 1,
        }}
      >
        <textarea
          ref={ref}
          aria-label="Message"
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          style={{
            flex: 1,
            minWidth: 0,
            resize: 'none',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: colors.textPrimary,
            font: `500 15px/1.4 ${fonts.ui}`,
            maxHeight: MAX_HEIGHT,
          }}
        />
        {leading}
        <Button
          onClick={() => void submit()}
          disabled={!canSend}
          aria-label="Send"
          style={{
            flex: 'none',
            padding: '6px 14px',
            borderRadius: radii.chip,
            font: `600 14px/1.2 ${fonts.ui}`,
            color: canSend ? colors.textPrimary : colors.textMuted,
            background: canSend ? colors.accentCyanSoft : 'transparent',
            border: `1px solid ${canSend ? colors.activeBorder : colors.chromeBorder}`,
          }}
        >
          Send
        </Button>
      </div>
    </div>
  );
}
