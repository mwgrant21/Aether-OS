import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function SystemsCard() {
  const { state, dispatch } = useAetherStore();
  const rows = [
    { k: 'Uplinks online', v: `${state.providers.filter((pv) => pv.connected).length} / ${state.providers.length}`, c: colors.success },
    { k: 'Memory engrams', v: String(state.memories.length), c: '#8ab6ff' },
    { k: 'Pinned', v: String(state.memories.filter((m) => m.pinned).length), c: colors.warn },
    { k: 'Pending approvals', v: String(state.approvals.length), c: state.approvals.length ? colors.warn : colors.success },
    { k: 'Idle agents', v: String(state.idleList.length), c: colors.textSecondary },
    { k: 'Default runtime', v: state.routeDefault.toUpperCase(), c: colors.accentCyan },
    { k: 'Sound', v: state.cfg.sound ? 'ON' : 'OFF', c: state.cfg.sound ? colors.success : colors.textMuted },
  ];

  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>SYSTEMS</div>
        <span onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Uplinks' })} style={viewAllStyle}>
          UPLINKS →
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', marginTop: 11, display: 'flex', flexDirection: 'column', gap: 9 }}>
        {rows.map((r) => (
          <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', font: `400 11px/1 ${fonts.mono}` }}>
            <span style={{ color: colors.textSecondary }}>{r.k}</span>
            <span style={{ color: r.c }}>{r.v}</span>
          </div>
        ))}
      </div>
      <div style={{ flex: 'none', font: `400 9px/1.5 ${fonts.mono}`, color: colors.textDim, paddingTop: 10, borderTop: `1px solid ${colors.chromeBorder}` }}>
        CTRL+K jumps anywhere · state persists across reloads
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const viewAllStyle: CSSProperties = { cursor: 'pointer', font: `600 10px/1 ${fonts.ui}`, letterSpacing: 1.5, color: colors.accentCyanSoft };
