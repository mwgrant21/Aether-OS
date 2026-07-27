import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';

export function Footer() {
  const colors = useColors();
  const { state } = useAetherStore();
  const c = state.alarmLevel === 'crit' ? colors.danger : state.alarmLevel === 'warn' ? colors.warn : colors.success;
  const label = state.alarmLevel === 'crit' ? 'BURN ALARM' : state.alarmLevel === 'warn' ? 'BURN ELEVATED' : 'ALL GOOD';
  return (
    <div style={rootStyle(colors)}>
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

function rootStyle(colors: ColorPalette): CSSProperties {
  return {
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
}
