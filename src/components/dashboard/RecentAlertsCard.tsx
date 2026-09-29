import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { Notif } from '../../state/types';
import { useColors } from '../shared/useColors';
import { EmptyState } from '../shared/EmptyState';

// Notifs carry no id, and new ones are prepended, so an array index would
// re-key every row on each new alert. Key on content instead, with an
// occurrence counter so two identical alerts in the same minute stay distinct.
export function notifKeys(notifs: readonly Notif[]): string[] {
  const seen = new Map<string, number>();
  return notifs.map((nf) => {
    const base = `${nf.t}\u0000${nf.m}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}\u0000${n}`;
  });
}

export function RecentAlertsCard() {
  const colors = useColors();
  const { state } = useAetherStore();
  const alerts = state.notifs.slice(0, 8);
  const keys = notifKeys(alerts);
  return (
    <div style={cardStyle(colors)}>
      <h2 style={{ ...titleStyle(colors), margin: 0 }}>RECENT ALERTS</h2>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 11, display: 'flex', flexDirection: 'column', gap: 9 }}>
        {alerts.map((nf, idx) => (
          <div key={keys[idx]} style={{ display: 'flex', gap: 9, font: `400 11px/1.5 ${fonts.mono}` }}>
            <span style={{ color: colors.textDim, flex: 'none' }}>{nf.t}</span>
            <span style={{ color: nf.c }}>{nf.m}</span>
          </div>
        ))}
        {!alerts.length && <EmptyState message="Anomalies and budget warnings will appear here." />}
      </div>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
