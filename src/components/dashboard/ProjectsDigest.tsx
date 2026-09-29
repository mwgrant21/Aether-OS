import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { useAetherStore } from '../../state/store';
import { usdPrecise } from '../ledger/format';
import { Button } from '../shared/Button';
import { EmptyState } from '../shared/EmptyState';

export function ProjectsDigest() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const top = state.projectsSnapshot?.roots.slice(0, 3) ?? [];

  return (
    <div style={cardStyle(colors)}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ ...titleStyle(colors), margin: 0 }}>PROJECTS</h2>
        <Button onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Projects' })} style={viewAllStyle(colors)}>
          VIEW ALL →
        </Button>
      </div>
      {top.length === 0 ? (
        <div style={emptySlotStyle}>
          <EmptyState message="Projects appear once a session writes a transcript." />
        </div>
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
const emptySlotStyle: CSSProperties = { marginTop: 11 };
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 };
function nameStyle(colors: ColorPalette): CSSProperties {
  return { flex: 1, font: `600 13px/1 ${fonts.ui}`, color: colors.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
}
function costStyle(colors: ColorPalette): CSSProperties {
  return { flex: 'none', font: `700 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft };
}
function viewAllStyle(colors: ColorPalette): CSSProperties {
  return { cursor: 'pointer', font: `600 11px/1 ${fonts.ui}`, letterSpacing: 1.5, color: colors.accentCyanSoft };
}
