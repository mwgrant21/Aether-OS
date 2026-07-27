import type { CSSProperties, KeyboardEvent } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';

interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  placeholder: string;
}

export function MessageInput({ value, onChange, onSend, disabled, placeholder }: MessageInputProps) {
  const colors = useColors();

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
          style={inputStyle(colors)}
        />
        <Button
          onClick={onSend}
          style={sendButtonStyle(disabled)}
          disabled={disabled}
        >
          ➤
        </Button>
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
function inputStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 1,
    font: `400 13px/1 ${fonts.ui}`,
    color: colors.textBody,
    background: 'transparent',
    border: 'none',
    outline: 'none',
    caretColor: colors.accentCyan,
  };
}
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
    color: 'inherit',
    boxShadow: disabled ? 'none' : '0 0 14px rgba(95,240,255,.5)',
  };
}
