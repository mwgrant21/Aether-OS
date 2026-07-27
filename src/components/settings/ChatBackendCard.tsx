import { type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { useChatBackendState, type ChatBackendState } from '../chat/useChatBackendState';

const COPY: Record<ChatBackendState, string> = {
  live: 'Live · Claude replies enabled',
  offline: 'Offline · in-world responder (no ANTHROPIC_API_KEY)',
  browser: 'Browser mode · replies via dev-server proxy',
};

export function ChatBackendCard() {
  const colors = useColors();
  const backendState = useChatBackendState();

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>CHAT BACKEND</div>
      <div style={{ marginTop: 12 }}>
        <div style={labelStyle(colors)}>CLAUDE REPLIES</div>
        <div style={valueStyle(colors, backendState)}>{backendState ? COPY[backendState] : 'Checking…'}</div>
      </div>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: 15,
    borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function labelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
}
function valueStyle(colors: ColorPalette, backendState: ChatBackendState | null): CSSProperties {
  return {
    marginTop: 8,
    font: `600 13px/1.4 ${fonts.ui}`,
    color: backendState === 'live' ? colors.success : backendState === 'offline' ? colors.warn : colors.textBody,
  };
}
