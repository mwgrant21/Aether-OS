import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { MemoryRow, MemoryTombstone } from '../../state/types';
import { KIND_TIER_COLOR } from './memoryMath';
import { useColors } from '../shared/useColors';
import { applyDensity } from '../../shared/transcriptDensity';

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function MemoryDetailCard({ memory, tombstone }: { memory: MemoryRow | null; tombstone: MemoryTombstone | null }) {
  const colors = useColors();
  const { state } = useAetherStore();

  if (!memory && !tombstone) {
    return (
      <div style={cardStyle(colors)}>
        <div style={emptyWrapStyle}>
          <div style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textSecondary }}>NO MEMORIES YET</div>
          <div style={{ marginTop: 8, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textMuted }}>
            Memories accumulate automatically as agents work — nothing to log manually here.
          </div>
        </div>
      </div>
    );
  }

  if (tombstone) {
    return (
      <div style={cardStyle(colors)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={badgeStyle(colors, colors.textDim)}>{tombstone.scope}</span>
          {tombstone.scope === 'private' && tombstone.ownerAgent && <span style={badgeStyle(colors, colors.textDim)}>{tombstone.ownerAgent}</span>}
        </div>

        <div style={{ marginTop: 6, font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>{formatTimestamp(tombstone.deletedAtMs)}</div>

        <div style={{ marginTop: 20, flex: 1, minHeight: 0, overflow: 'auto' }}>
          <div style={sectionLabelStyle(colors)}>CONTENT</div>
          <div style={{ marginTop: 8, font: `400 13px/1.6 ${fonts.ui}`, color: colors.textBody }}>
            {applyDensity(tombstone.content, state.cfg.densityLevel, `tombstone-${tombstone.id}`)}
          </div>
          <div style={{ marginTop: 16 }}>
            <div style={sectionLabelStyle(colors)}>CAUSE</div>
            <div style={{ marginTop: 8, font: `400 13px/1.5 ${fonts.ui}`, color: colors.textBody }}>{tombstone.cause}</div>
          </div>
          {tombstone.supersededBy != null && (
            <div style={{ marginTop: 12, font: `400 11px/1.4 ${fonts.mono}`, color: colors.textDim }}>
              superseded by #{tombstone.supersededBy}
            </div>
          )}
        </div>
      </div>
    );
  }

  const m = memory as MemoryRow;
  const kindColor = KIND_TIER_COLOR(m.kind);

  return (
    <div style={cardStyle(colors)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={badgeStyle(colors, kindColor)}>{m.kind}</span>
        <span style={badgeStyle(colors, colors.textDim)}>{m.scope}</span>
        {m.scope === 'private' && m.ownerAgent && <span style={badgeStyle(colors, colors.textDim)}>{m.ownerAgent}</span>}
      </div>

      <div style={{ marginTop: 6, font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>
        {formatTimestamp(m.createdAtMs)}
        {m.updatedAtMs !== m.createdAtMs && <> · updated {formatTimestamp(m.updatedAtMs)}</>}
      </div>

      <div style={{ marginTop: 20, flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div style={sectionLabelStyle(colors)}>CONTENT</div>
        <div style={{ marginTop: 8, font: `400 13px/1.6 ${fonts.ui}`, color: colors.textBody }}>
          {applyDensity(m.content, state.cfg.densityLevel, `memory-${m.id}`)}
        </div>
      </div>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    padding: 18,
    borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    display: 'flex',
    flexDirection: 'column',
  };
}
const emptyWrapStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
};
function badgeStyle(_colors: ColorPalette, accent: string): CSSProperties {
  return {
    flex: 'none',
    font: `600 8px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: accent,
    border: `1px solid ${accent}`,
    padding: '4px 7px',
    borderRadius: 4,
    maxWidth: 120,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'center',
  };
}
function sectionLabelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
}
