import type { CSSProperties, KeyboardEvent } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';

interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
}

// The filter box, not a send box (Stage 14, Task 3). No send affordance: a
// disabled send button is the "looks-alive-isn't" class this project has
// repeatedly designed against, and there is no send path in this stage.
// Typing narrows the thread live (onChange); Enter also submits the current
// text to CommsView, which — only for the AETHER channel, and only when the
// text isn't a /tool /human /error filter expression — routes it to
// localResponder (kept per the design doc's "What happens to localResponder"
// decision). Enter on a filter expression, or on any other channel, is a
// no-op beyond the live narrowing that already happened on change.
export function MessageInput({ value, onChange, onSubmit, placeholder }: MessageInputProps) {
  const colors = useColors();

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') onSubmit();
  }

  return (
    <div style={barStyle}>
      <div style={rowStyle(colors)}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          spellCheck={false}
          style={inputStyle(colors)}
        />
      </div>
    </div>
  );
}

const barStyle: CSSProperties = { flex: 'none', paddingTop: 12 };
function rowStyle(colors: ColorPalette): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    borderRadius: 10,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelInset,
  };
}
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
