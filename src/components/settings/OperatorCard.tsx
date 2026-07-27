import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';

export function OperatorCard() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>IDENTITY</div>
      <div style={{ marginTop: 12 }}>
        <div style={labelStyle(colors)}>YOUR NAME</div>
        <input
          type="text"
          maxLength={24}
          value={state.operatorName}
          onChange={(e) => dispatch({ type: 'SET_OPERATOR_NAME', name: e.target.value })}
          placeholder="Operator"
          style={inputStyle(colors)}
        />
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

function inputStyle(colors: ColorPalette): CSSProperties {
  return {
    width: '100%',
    marginTop: 8,
    padding: '9px 12px',
    borderRadius: 8,
    border: '1px solid rgba(80,190,220,.25)',
    background: 'rgba(10,32,43,.6)',
    color: colors.textPrimary,
    font: `600 13px/1 ${fonts.ui}`,
    outline: 'none',
  };
}
