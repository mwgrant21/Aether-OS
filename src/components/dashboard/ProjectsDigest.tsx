import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { STATUS_COLOR, computeLiveProjectPct } from '../projects/projectsMath';
import { Button } from '../shared/Button';

export function ProjectsDigest() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const projects = state.projects.slice(0, 6).map((p) => ({
    ...p,
    pct: computeLiveProjectPct(p, state.used),
  }));

  return (
    <div style={cardStyle(colors)}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle(colors)}>PROJECTS</div>
        <Button
          onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Projects' })}
          style={viewAllStyle(colors)}
          hoverStyle={{ textDecoration: 'underline' }}
        >
          VIEW ALL ›
        </Button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 11, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {projects.map((p) => (
          <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <span style={statusBadgeStyle(STATUS_COLOR[p.status])}>{p.status}</span>
            <span style={nameStyle(colors)}>{p.name}</span>
            <span style={{ flex: 'none', font: `700 11px/1 ${fonts.mono}`, color: p.hue }}>{p.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function viewAllStyle(colors: ColorPalette): CSSProperties {
  return { cursor: 'pointer', font: `600 10px/1 ${fonts.ui}`, letterSpacing: 1.5, color: colors.accentCyanSoft };
}
function nameStyle(colors: ColorPalette): CSSProperties {
  return { flex: 1, font: `600 13px/1 ${fonts.ui}`, color: colors.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
}
function statusBadgeStyle(c: string): CSSProperties {
  return { flex: 'none', font: `600 8px/1 ${fonts.ui}`, letterSpacing: 1, color: c, border: `1px solid ${c}55`, padding: '4px 7px', borderRadius: 4, width: 56, textAlign: 'center' };
}
