import { useState } from 'react';
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { MemoryStub } from '../../state/types';
import { STRENGTH_TIER_COLOR, groupMemoriesForRoster } from './memoryMath';

export function MemoryRosterCard({ selectedId }: { selectedId: number | null }) {
  const { state, dispatch } = useAetherStore();
  const { pinned, unpinned } = groupMemoriesForRoster(state.memories);
  const [rememberText, setRememberText] = useState('');

  function submitRemember() {
    const text = rememberText.trim();
    if (!text) return;
    dispatch({ type: 'RUN_COMMAND', raw: `remember ${text}` });
    setRememberText('');
  }

  const row = (m: MemoryStub) => {
    const on = m.id === selectedId;
    return (
      <div key={m.id} onClick={() => dispatch({ type: 'SELECT_MEMORY', id: m.id })} style={rowStyle(on)}>
        <span style={sourceBadgeStyle}>{m.source}</span>
        <span style={nameStyle}>{m.name}</span>
        <span style={{ flex: 'none', font: `700 11px/1 ${fonts.mono}`, color: STRENGTH_TIER_COLOR(m.strength) }}>{Math.round(m.strength)}</span>
      </div>
    );
  };

  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none' }}>
        <div style={titleStyle}>MEMORY</div>
      </div>

      <div style={{ flex: 'none', display: 'flex', gap: 6, marginTop: 10 }}>
        <input
          value={rememberText}
          onChange={(e) => setRememberText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitRemember();
          }}
          placeholder="remember something..."
          spellCheck={false}
          style={rememberInputStyle}
        />
        <span onClick={submitRemember} style={rememberButtonStyle}>
          +
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {pinned.length > 0 && (
          <div>
            <div style={groupHeaderStyle}>PINNED ({pinned.length})</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>{pinned.map(row)}</div>
          </div>
        )}
        <div>
          <div style={groupHeaderStyle}>ENGRAMS ({unpinned.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>{unpinned.map(row)}</div>
        </div>
        {!state.memories.length && <div style={emptyStyle}>no memories logged yet — try `remember &lt;text&gt;` in the Terminal</div>}
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
const sourceBadgeStyle: CSSProperties = {
  flex: 'none',
  font: `600 8px/1 ${fonts.ui}`,
  letterSpacing: 1,
  color: colors.accentCyanSoft,
  border: `1px solid rgba(95,220,255,.35)`,
  padding: '4px 7px',
  borderRadius: 4,
  maxWidth: 76,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'center',
};
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
const rememberInputStyle: CSSProperties = {
  flex: 1,
  font: `400 12px/1 ${fonts.mono}`,
  color: colors.textBody,
  background: 'rgba(6,20,28,.7)',
  border: '1px solid rgba(80,190,220,.25)',
  borderRadius: 7,
  padding: '7px 9px',
  outline: 'none',
};
const rememberButtonStyle: CSSProperties = {
  flex: 'none',
  width: 30,
  cursor: 'pointer',
  display: 'grid',
  placeItems: 'center',
  borderRadius: 7,
  border: '1px solid rgba(80,190,220,.25)',
  color: colors.accentCyanSoft,
  font: `700 14px/1 ${fonts.ui}`,
};
