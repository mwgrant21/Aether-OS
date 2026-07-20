import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function OperatorCard() {
  const { state, dispatch } = useAetherStore();

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>IDENTITY</div>
      <div style={{ marginTop: 12 }}>
        <div style={labelStyle}>YOUR NAME</div>
        <input
          type="text"
          maxLength={24}
          value={state.operatorName}
          onChange={(e) => dispatch({ type: 'SET_OPERATOR_NAME', name: e.target.value })}
          placeholder="Operator"
          style={inputStyle}
        />
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  padding: 15,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const labelStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
const inputStyle: CSSProperties = {
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
