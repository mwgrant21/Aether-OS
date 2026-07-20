import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { groupFilesByAgent } from './filesMath';

export function FilesView() {
  const { state, dispatch } = useAetherStore();
  const groups = groupFilesByAgent(state.agents);

  const openAgent = (name: string) => {
    dispatch({ type: 'SELECT_AGENT', name });
    dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Agents' });
  };

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>FILES</div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {groups.map((g) => (
          <div key={g.name}>
            <div style={groupHeaderStyle}>
              <span style={avatarStyle(g.hue)}>{g.i}</span>
              <span style={{ font: `700 13px/1 ${fonts.ui}`, color: colors.textPrimary }}>{g.name}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, marginLeft: 34 }}>
              {g.files.map((f, idx) => (
                <div key={idx} onClick={() => openAgent(g.name)} style={rowStyle}>
                  <span style={{ color: f.c, flex: 'none', font: `400 12px/1.5 ${fonts.mono}` }}>{f.s}</span>
                  <span style={{ color: colors.textSecondary, font: `400 12px/1.5 ${fonts.mono}` }}>{f.n}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        {!groups.length && <div style={emptyStyle}>no files touched yet — spawn an agent to see its work appear here</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  padding: 18,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
};
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const groupHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
function avatarStyle(hue: string): CSSProperties {
  return {
    width: 24,
    height: 24,
    flex: 'none',
    borderRadius: 6,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 5px,#123f4e 5px 10px)',
    border: `1px solid ${hue}`,
    display: 'grid',
    placeItems: 'center',
    font: `700 10px/1 ${fonts.mono}`,
    color: hue,
  };
}
const rowStyle: CSSProperties = { display: 'flex', gap: 8, cursor: 'pointer' };
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
