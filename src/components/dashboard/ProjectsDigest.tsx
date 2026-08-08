import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { useAetherStore } from '../../state/store';
import { usdPrecise } from '../ledger/format';

export function ProjectsDigest() {
  const colors = useColors();
  const { state } = useAetherStore();
  const top = state.projectsSnapshot?.roots.slice(0, 3) ?? [];

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>PROJECTS</div>
      {top.length === 0 ? (
        <div style={emptyStyle(colors)}>No projects observed yet.</div>
      ) : (
        top.map((p) => (
          <div key={p.key} style={rowStyle}>
            <span style={nameStyle(colors)}>{p.name}</span>
            <span style={costStyle(colors)}>{usdPrecise(p.ledger.total.usd)}</span>
          </div>
        ))
      )}
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function emptyStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 11, font: `500 12px/1.4 ${fonts.ui}`, color: colors.textDim };
}
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 };
function nameStyle(colors: ColorPalette): CSSProperties {
  return { flex: 1, font: `600 13px/1 ${fonts.ui}`, color: colors.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
}
function costStyle(colors: ColorPalette): CSSProperties {
  return { flex: 'none', font: `700 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft };
}
