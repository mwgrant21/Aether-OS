import type { CSSProperties, KeyboardEvent } from 'react';
import { colors, fonts } from '../../styles/tokens';

interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  placeholder: string;
}

export function MessageInput({ value, onChange, onSend, disabled, placeholder }: MessageInputProps) {
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') onSend();
  }

  return (
    <div style={barStyle}>
      <div style={rowStyle}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          style={inputStyle}
        />
        <span onClick={disabled ? undefined : onSend} style={sendButtonStyle(disabled)}>
          ➤
        </span>
      </div>
    </div>
  );
}

const barStyle: CSSProperties = { flex: 'none', paddingTop: 12 };
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderRadius: 10,
  border: '1px solid rgba(80,190,220,.3)',
  background: 'rgba(6,20,28,.7)',
};
const inputStyle: CSSProperties = {
  flex: 1,
  font: `400 13px/1 ${fonts.ui}`,
  color: colors.textBody,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  caretColor: colors.accentCyan,
};
function sendButtonStyle(disabled: boolean): CSSProperties {
  return {
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    width: 30,
    height: 30,
    borderRadius: 8,
    background: 'linear-gradient(180deg,#17b8d8,#0f7f97)',
    display: 'grid',
    placeItems: 'center',
    color: colors.textPrimary,
    boxShadow: disabled ? 'none' : '0 0 14px rgba(95,240,255,.5)',
  };
}
