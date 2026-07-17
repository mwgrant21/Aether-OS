import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function Footer() {
  const { state } = useAetherStore();
  const c = state.alarmLevel === 'crit' ? colors.danger : state.alarmLevel === 'warn' ? colors.warn : colors.success;
  const label = state.alarmLevel === 'crit' ? 'BURN ALARM' : state.alarmLevel === 'warn' ? 'BURN ELEVATED' : 'ALL GOOD';
  return (
    <div style={rootStyle}>
      {/* Product display version from the design source — intentionally independent of package.json's dev version */}
      <span>◇ AETHER OS v1.0.0</span>
      <span style={{ color: colors.textMuted }}>Reactor draws power on demand — tokens are contained, never wasted.</span>
      <span style={{ marginLeft: 'auto' }}>Uptime 3h 42m</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: c }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: c, boxShadow: `0 0 8px ${c}` }} />
        {label}
      </span>
    </div>
  );
}

const rootStyle: CSSProperties = {
  height: 34,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 18,
  padding: '0 22px',
  borderTop: `1px solid ${colors.chromeBorder}`,
  background: 'rgba(4,16,24,.7)',
  font: `400 11px/1 ${fonts.mono}`,
  color: colors.textDim,
};
