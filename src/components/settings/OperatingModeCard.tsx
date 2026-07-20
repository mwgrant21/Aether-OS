import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { OpMode } from '../../state/types';

const OP_MODES: { key: OpMode; label: string; tip: string }[] = [
  { key: 'PLAN', label: '◇ PLAN', tip: 'Brainstorm & plan — throttled burn, everything queued for approval' },
  { key: 'EDITS', label: '✎ EDITS', tip: 'Accept edits — agents work, risky actions queue for approval' },
  { key: 'AUTO', label: '⚡ AUTO', tip: 'Full auto — low/med actions auto-approved, max burn' },
];

export function OperatingModeCard() {
  const { state, dispatch } = useAetherStore();

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>OPERATING MODE</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        {OP_MODES.map((om) => {
          const on = state.cfg.opMode === om.key;
          return (
            <span key={om.key} title={om.tip} onClick={() => dispatch({ type: 'SET_OP_MODE', mode: om.key })} style={opModeStyle(on, om.key)}>
              {om.label}
            </span>
          );
        })}
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
function opModeStyle(on: boolean, key: OpMode): CSSProperties {
  return {
    flex: 1,
    textAlign: 'center',
    cursor: 'pointer',
    padding: '10px 0',
    borderRadius: 8,
    font: `600 11px/1 ${fonts.ui}`,
    letterSpacing: 1.5,
    color: on ? (key === 'AUTO' ? '#1a1204' : '#04202b') : colors.textMuted,
    background: on ? (key === 'AUTO' ? 'linear-gradient(180deg,#f5c66b,#d9a13f)' : 'linear-gradient(180deg,#7ef0ff,#17b8d8)') : 'rgba(10,32,43,.6)',
    boxShadow: on ? (key === 'AUTO' ? '0 0 12px rgba(245,198,107,.45)' : '0 0 12px rgba(95,220,255,.4)') : undefined,
    border: on ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
