import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { ProjectStatus } from '../../state/types';

const STATUS_COLOR: Record<ProjectStatus, string> = {
  BUILDING: '#7ef0ff',
  REVIEW: '#f5c66b',
  QUEUED: '#5f8a97',
  SHIPPED: '#3be0a0',
};

export function ProjectsDigest() {
  const { state, dispatch } = useAetherStore();
  const projects = state.projects.slice(0, 6).map((p) => ({
    ...p,
    pct: p.status === 'BUILDING' ? Math.min(99, Math.round(p.pct + (state.used - 24391) / 30000)) : p.pct,
  }));

  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>PROJECTS</div>
        <span onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Projects' })} style={viewAllStyle}>
          VIEW ALL →
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 11, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {projects.map((p) => (
          <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <span style={statusBadgeStyle(STATUS_COLOR[p.status])}>{p.status}</span>
            <span style={nameStyle}>{p.name}</span>
            <span style={{ flex: 'none', font: `700 11px/1 ${fonts.mono}`, color: p.hue }}>{p.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const viewAllStyle: CSSProperties = { cursor: 'pointer', font: `600 10px/1 ${fonts.ui}`, letterSpacing: 1.5, color: colors.accentCyanSoft };
const nameStyle: CSSProperties = { flex: 1, font: `600 13px/1 ${fonts.ui}`, color: colors.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
function statusBadgeStyle(c: string): CSSProperties {
  return { flex: 'none', font: `600 8px/1 ${fonts.ui}`, letterSpacing: 1, color: c, border: `1px solid ${c}55`, padding: '4px 7px', borderRadius: 4, width: 56, textAlign: 'center' };
}
