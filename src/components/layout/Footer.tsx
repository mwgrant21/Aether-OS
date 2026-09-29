import { useEffect, useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { isSessionLive } from '../dashboard/dashboardMath';
import { formatUptime } from '../../utils/format';

export function Footer() {
  const colors = useColors();
  const { state } = useAetherStore();
  const [version, setVersion] = useState<string | null>(null);
  const live = isSessionLive(state, Date.now());
  const c = state.alarmLevel === 'crit' ? colors.danger : state.alarmLevel === 'warn' ? colors.warn : live ? colors.success : colors.textMuted;
  const label = state.alarmLevel === 'crit' ? 'BURN ALARM' : state.alarmLevel === 'warn' ? 'BURN ELEVATED' : live ? 'ALL GOOD' : 'STANDBY';

  useEffect(() => {
    window.aetherElectron?.app.getVersion().then(setVersion);
  }, []);

  return (
    <footer style={rootStyle(colors)}>
      <span>◇ AETHER OS {version ? `v${version}` : ''}</span>
      <span style={{ marginLeft: 'auto' }}>Uptime {formatUptime(state.sessionStartedAt, new Date())}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: c }} aria-live="polite">
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: c, boxShadow: `0 0 8px ${c}` }} />
        {label}
      </span>
    </footer>
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
