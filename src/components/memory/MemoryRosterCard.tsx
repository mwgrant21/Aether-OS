import { useState } from 'react';
import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { MemoryStub } from '../../state/types';
import { STRENGTH_TIER_COLOR, groupMemoriesForRoster } from './memoryMath';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';

export function MemoryRosterCard({ selectedId }: { selectedId: number | null }) {
  const colors = useColors();
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
      <Button key={m.id} onClick={() => dispatch({ type: 'SELECT_MEMORY', id: m.id })} style={rowStyle(on)}>
        <span style={sourceBadgeStyle(colors)}>{m.source}</span>
        <span style={nameStyle(colors)}>{m.name}</span>
        <span style={{ flex: 'none', font: `700 11px/1 ${fonts.mono}`, color: STRENGTH_TIER_COLOR(m.strength) }}>{Math.round(m.strength)}</span>
      </Button>
    );
  };

  return (
    <div style={cardStyle(colors)}>
      <div style={{ flex: 'none' }}>
        <div style={titleStyle(colors)}>MEMORY</div>
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
          style={rememberInputStyle(colors)}
        />
        <span onClick={submitRemember} style={rememberButtonStyle(colors)}>
          +
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {pinned.length > 0 && (
          <div>
            <div style={groupHeaderStyle(colors)}>PINNED ({pinned.length})</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>{pinned.map(row)}</div>
          </div>
        )}
        <div>
          <div style={groupHeaderStyle(colors)}>ENGRAMS ({unpinned.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>{unpinned.map(row)}</div>
        </div>
        {!state.memories.length && <div style={emptyStyle(colors)}>no memories logged yet — try `remember &lt;text&gt;` in the Terminal</div>}
      </div>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
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
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function groupHeaderStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textDim };
}
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
function nameStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 1,
    font: `600 13px/1 ${fonts.ui}`,
    color: colors.textPrimary,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}
function sourceBadgeStyle(colors: ColorPalette): CSSProperties {
  return {
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
}
function emptyStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
}
function rememberInputStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 1,
    font: `400 12px/1 ${fonts.mono}`,
    color: colors.textBody,
    background: colors.panelInset,
    border: '1px solid rgba(80,190,220,.25)',
    borderRadius: 7,
    padding: '7px 9px',
    outline: 'none',
  };
}
function rememberButtonStyle(colors: ColorPalette): CSSProperties {
  return {
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
}
