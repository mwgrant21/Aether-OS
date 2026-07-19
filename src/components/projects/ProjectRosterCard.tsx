import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { STATUS_COLOR, computeLiveProjectPct, groupProjectsByStatus } from './projectsMath';

export function ProjectRosterCard({ selectedName }: { selectedName: string | null }) {
  const { state, dispatch } = useAetherStore();
  const groups = groupProjectsByStatus(state.projects);

  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>PROJECTS</div>
        <span onClick={() => dispatch({ type: 'NEW_PROJECT' })} style={addButtonStyle}>
          + ADD
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {groups.map((group) => (
          <div key={group.status}>
            <div style={groupHeaderStyle}>
              {group.status} ({group.projects.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {group.projects.map((p) => {
                const on = p.name === selectedName;
                const pct = computeLiveProjectPct(p, state.used);
                return (
                  <div key={p.name} onClick={() => dispatch({ type: 'SELECT_PROJECT', name: p.name })} style={rowStyle(on)}>
                    <span style={statusBadgeStyle(STATUS_COLOR[p.status])}>{p.status}</span>
                    <span style={nameStyle}>{p.name}</span>
                    <span style={{ flex: 'none', font: `700 11px/1 ${fonts.mono}`, color: p.hue }}>{pct}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {!state.projects.length && <div style={emptyStyle}>no projects yet — add one to get started</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  width: 300,
  flex: 'none',
  padding: 15,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const addButtonStyle: CSSProperties = {
  cursor: 'pointer',
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: 1,
  color: colors.accentCyanSoft,
  padding: '4px 9px',
  borderRadius: 6,
  border: '1px solid rgba(95,220,255,.35)',
};
const groupHeaderStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textDim };
function rowStyle(on: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 9px',
    borderRadius: 9,
    cursor: 'pointer',
    background: on ? 'rgba(23,184,216,.14)' : undefined,
    border: on ? '1px solid rgba(95,220,255,.4)' : '1px solid transparent',
  };
}
const nameStyle: CSSProperties = {
  flex: 1,
  font: `600 13px/1 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
function statusBadgeStyle(c: string): CSSProperties {
  return { flex: 'none', font: `600 8px/1 ${fonts.ui}`, letterSpacing: 1, color: c, border: `1px solid ${c}55`, padding: '4px 7px', borderRadius: 4, width: 56, textAlign: 'center' };
}
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
