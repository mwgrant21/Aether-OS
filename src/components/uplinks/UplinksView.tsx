import type { CSSProperties } from 'react';
import { fonts, space, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';

export function UplinksView() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const runtimeOptions = ['Auto', ...state.providers.map((p) => p.name)];

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>PROVIDERS</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        {state.providers.map((p) => (
          <div key={p.name} style={rowStyle(p.connected)}>
            <span style={dotStyle(colors, p.connected)} />
            <span style={nameStyle(colors)}>{p.name}</span>
            <span style={badgeStyle(colors, p.connected)}>{p.connected ? 'ONLINE' : 'OFFLINE'}</span>
            <Button
              onClick={() => dispatch({ type: 'TOGGLE_PROVIDER_CONNECTION', name: p.name })}
              style={toggleButtonStyle(colors, p.connected)}
            >
              {p.connected ? 'DISCONNECT' : 'CONNECT'}
            </Button>
          </div>
        ))}
      </div>

      <div style={{ marginTop: space.xl }}>
        <div style={titleStyle(colors)}>DEFAULT RUNTIME</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {runtimeOptions.map((option) => (
            <Button
              key={option}
              onClick={() => dispatch({ type: 'SET_ROUTE_DEFAULT', value: option })}
              style={pillStyle(colors, state.routeDefault === option)}
            >
              {option}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: 18,
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
function rowStyle(connected: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    borderRadius: 9,
    border: '1px solid rgba(80,190,220,.16)',
    background: 'rgba(6,20,28,.5)',
    opacity: connected ? 1 : 0.55,
  };
}
function dotStyle(colors: ColorPalette, connected: boolean): CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flex: 'none',
    background: connected ? colors.success : colors.textDim,
    boxShadow: connected ? '0 0 8px rgba(59,224,160,.8)' : undefined,
  };
}
function nameStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    font: `600 13px/1 ${fonts.ui}`,
    color: colors.textPrimary,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}
function badgeStyle(colors: ColorPalette, connected: boolean): CSSProperties {
  const c = connected ? colors.success : colors.textDim;
  return { flex: 'none', font: `600 9px/1 ${fonts.ui}`, letterSpacing: 1, color: c, border: `1px solid ${c}55`, padding: '4px 8px', borderRadius: 4 };
}
function toggleButtonStyle(colors: ColorPalette, connected: boolean): CSSProperties {
  return {
    flex: 'none',
    cursor: 'pointer',
    textAlign: 'center',
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    padding: '6px 12px',
    borderRadius: 7,
    color: connected ? colors.dangerSoft : '#04202b',
    background: connected ? 'rgba(255,90,90,.06)' : 'linear-gradient(180deg,#7ef0ff,#17b8d8)',
    border: connected ? '1px solid rgba(255,120,120,.4)' : 'none',
    boxShadow: connected ? undefined : '0 0 10px rgba(95,220,255,.4)',
  };
}
function pillStyle(colors: ColorPalette, on: boolean): CSSProperties {
  return {
    cursor: 'pointer',
    textAlign: 'center',
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    padding: '7px 14px',
    borderRadius: 7,
    color: on ? '#04202b' : colors.textMuted,
    background: on ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    boxShadow: on ? '0 0 10px rgba(95,220,255,.4)' : undefined,
    border: on ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
