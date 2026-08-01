import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { MemoryRow, MemoryTombstone } from '../../state/types';
import { groupMemoriesByScope, KIND_TIER_COLOR } from './memoryMath';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';

export function MemoryRosterCard({ selectedId }: { selectedId: number | null }) {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const filter = state.memoryScopeFilter;
  const showTombstones = state.memoryShowTombstones;

  const agents = [...groupMemoriesByScope(state.memories).byAgent.keys()];

  function matchesFilter(scope: 'shared' | 'private', ownerAgent: string | null): boolean {
    if (filter === 'all') return true;
    if (filter === 'shared') return scope === 'shared';
    return scope === 'private' && ownerAgent === filter;
  }

  const filteredMemories = state.memories.filter((m) => matchesFilter(m.scope, m.ownerAgent));
  const filteredTombstones = state.memoryTombstones.filter((t) => matchesFilter(t.scope, t.ownerAgent));
  const { shared, byAgent } = groupMemoriesByScope(filteredMemories);

  const memoryRow = (m: MemoryRow) => {
    const on = m.id === selectedId;
    return (
      <Button key={m.id} onClick={() => dispatch({ type: 'SELECT_MEMORY', id: m.id })} style={rowStyle(on)}>
        <span style={kindBadgeStyle(colors, KIND_TIER_COLOR(m.kind))}>{m.kind}</span>
        <span style={nameStyle(colors)}>{m.content}</span>
        <span style={{ flex: 'none', font: `700 11px/1 ${fonts.mono}`, color: colors.textDim }}>{m.salience}</span>
      </Button>
    );
  };

  const tombstoneRow = (t: MemoryTombstone) => {
    const on = t.id === selectedId;
    return (
      <Button key={t.id} onClick={() => dispatch({ type: 'SELECT_MEMORY', id: t.id })} style={rowStyle(on)}>
        <span style={kindBadgeStyle(colors, colors.textDim)}>{t.scope}</span>
        <span style={nameStyle(colors)}>{t.content}</span>
        <span style={{ flex: 'none', font: `600 9px/1 ${fonts.mono}`, color: colors.textDim }}>{t.cause}</span>
      </Button>
    );
  };

  return (
    <div style={cardStyle(colors)}>
      <div style={{ flex: 'none' }}>
        <div style={titleStyle(colors)}>MEMORY</div>
      </div>

      <div style={{ flex: 'none', display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        <Button onClick={() => dispatch({ type: 'SET_MEMORY_SCOPE_FILTER', filter: 'all' })} style={filterButtonStyle(colors, filter === 'all')}>
          All
        </Button>
        <Button onClick={() => dispatch({ type: 'SET_MEMORY_SCOPE_FILTER', filter: 'shared' })} style={filterButtonStyle(colors, filter === 'shared')}>
          Shared
        </Button>
        {agents.map((agent) => (
          <Button key={agent} onClick={() => dispatch({ type: 'SET_MEMORY_SCOPE_FILTER', filter: agent })} style={filterButtonStyle(colors, filter === agent)}>
            {agent}
          </Button>
        ))}
        <Button
          onClick={() => dispatch({ type: 'TOGGLE_MEMORY_TOMBSTONE_VIEW' })}
          style={filterButtonStyle(colors, showTombstones)}
          title={showTombstones ? 'Show live memories' : 'Show tombstones'}
        >
          {showTombstones ? '⌛ Tombstones' : '🪦 Tombstones'}
        </Button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {showTombstones ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{filteredTombstones.map(tombstoneRow)}</div>
            {!filteredTombstones.length && <div style={emptyStyle(colors)}>no tombstones for this filter</div>}
          </>
        ) : (
          <>
            {(filter === 'all' || filter === 'shared') && (
              <div>
                <div style={groupHeaderStyle(colors)}>SHARED ({shared.length})</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>{shared.map(memoryRow)}</div>
              </div>
            )}
            {[...byAgent.entries()].map(([agent, rows]) => (
              <div key={agent}>
                <div style={groupHeaderStyle(colors)}>{agent.toUpperCase()} ({rows.length})</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>{rows.map(memoryRow)}</div>
              </div>
            ))}
            {!filteredMemories.length && <div style={emptyStyle(colors)}>no memories captured yet</div>}
          </>
        )}
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
function kindBadgeStyle(_colors: ColorPalette, accent: string): CSSProperties {
  return {
    flex: 'none',
    font: `600 8px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: accent,
    border: `1px solid ${accent}`,
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
function filterButtonStyle(colors: ColorPalette, on: boolean): CSSProperties {
  return {
    flex: 'none',
    cursor: 'pointer',
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 0.5,
    color: on ? colors.accentCyanSoft : colors.textDim,
    border: `1px solid ${on ? 'rgba(95,220,255,.5)' : 'rgba(80,190,220,.25)'}`,
    background: on ? 'rgba(23,184,216,.14)' : 'transparent',
    borderRadius: 6,
    padding: '5px 8px',
  };
}
