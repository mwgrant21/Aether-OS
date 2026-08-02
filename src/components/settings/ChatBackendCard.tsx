import { useEffect, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { useChatBackendState, type ChatBackendState } from '../chat/useChatBackendState';

const COPY: Record<ChatBackendState, string> = {
  live: 'Live · Claude replies enabled',
  offline: 'Offline · in-world responder (no ANTHROPIC_API_KEY)',
  browser: 'Browser mode · replies via dev-server proxy',
};

export function ChatBackendCard() {
  const colors = useColors();
  const backendState = useChatBackendState();
  const { state, dispatch } = useAetherStore();
  const { autoHeadlines } = state.cfg;

  // Push the persisted preference to main on every mount (covers app restart,
  // where main.ts always starts with its own default until told otherwise)
  // and on every toggle.
  useEffect(() => {
    window.aetherElectron?.agents.setAutoHeadlines(autoHeadlines);
  }, [autoHeadlines]);

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>CHAT BACKEND</div>
      <div style={{ marginTop: 12 }}>
        <div style={labelStyle(colors)}>CLAUDE REPLIES</div>
        <div style={valueStyle(colors, backendState)}>{backendState ? COPY[backendState] : 'Checking…'}</div>
        {backendState === 'offline' && (
          <div style={hintStyle(colors)}>
            A packaged build only reads this from the real environment — a .env beside the
            app is not read (it resolves inside app.asar).
          </div>
        )}
      </div>

      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle(colors)}>AUTO HEADLINES</div>
        <Button
          onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { autoHeadlines: !autoHeadlines } })}
          style={toggleStyle(colors, autoHeadlines)}
        >
          {autoHeadlines ? 'ON' : 'OFF'}
        </Button>
      </div>
      <div style={hintStyle(colors)}>
        Periodically updates each active agent's status line with a snippet of its current
        work, computed locally with no API call and no cost. Turn off to keep the roster on
        each dispatch's static description instead.
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
    flexShrink: 0,
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
function toggleStyle(colors: ColorPalette, on: boolean): CSSProperties {
  return {
    minWidth: 52,
    textAlign: 'center',
    cursor: 'pointer',
    padding: '6px 12px',
    borderRadius: 7,
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: on ? '#04202b' : colors.textMuted,
    background: on ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    boxShadow: on ? '0 0 10px rgba(95,220,255,.4)' : undefined,
    border: on ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
function hintStyle(colors: ColorPalette): CSSProperties {
  return {
    marginTop: 6,
    font: `500 11px/1.4 ${fonts.ui}`,
    color: colors.textMuted,
  };
}
