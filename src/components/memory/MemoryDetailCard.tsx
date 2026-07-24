import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { MemoryStub } from '../../state/types';
import { STRENGTH_TIER_COLOR } from './memoryMath';
import { short, fmtElapsed } from '../../utils/format';

export function MemoryDetailCard({ memory }: { memory: MemoryStub | null }) {
  const { state, dispatch } = useAetherStore();

  if (!memory) {
    return (
      <div style={cardStyle}>
        <div style={emptyWrapStyle}>
          <div style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textSecondary }}>NO MEMORIES YET</div>
          <div style={{ marginTop: 8, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textMuted }}>
            Log one with `remember &lt;text&gt;` in the Terminal.
          </div>
        </div>
      </div>
    );
  }

  const tierColor = STRENGTH_TIER_COLOR(memory.strength);
  const usage = memory.toolUseId ? state.dispatchUsage[memory.toolUseId] : undefined;

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: `700 18px/1 ${fonts.ui}`, color: colors.textPrimary }}>{memory.name}</div>
        </div>
        <span style={sourceBadgeStyle}>{memory.source}</span>
      </div>

      <div style={{ marginTop: 6, font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>{memory.ts}</div>

      <div style={trackStyle}>
        <div style={{ height: '100%', width: `${memory.strength}%`, background: tierColor, boxShadow: `0 0 10px ${tierColor}` }} />
      </div>
      <div style={{ marginTop: 6 }}>
        <span style={{ font: `700 13px/1 ${fonts.mono}`, color: tierColor }}>{Math.round(memory.strength)}% strength</span>
      </div>

      <div style={{ marginTop: 20, flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div style={sectionLabelStyle}>CONTENT</div>
        <div style={{ marginTop: 8, font: `400 13px/1.6 ${fonts.ui}`, color: colors.textBody }}>{memory.content}</div>
        {usage && (
          <div style={{ marginTop: 12, font: `400 11px/1.4 ${fonts.mono}`, color: colors.textDim }}>
            Used {short(usage.tokens)} tokens · {usage.toolUses} tool call{usage.toolUses === 1 ? '' : 's'} · {fmtElapsed(usage.durationMs)}
          </div>
        )}
      </div>

      <div style={{ marginTop: 'auto', paddingTop: 16 }}>
        <span
          onClick={() => dispatch({ type: 'TOGGLE_MEMORY_PIN', id: memory.id })}
          style={memory.pinned ? dangerActionStyle : secondaryActionStyle}
        >
          {memory.pinned ? '✕ UNPIN' : '📌 PIN'}
        </span>
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
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
const emptyWrapStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
};
const sourceBadgeStyle: CSSProperties = {
  flex: 'none',
  font: `600 8px/1 ${fonts.ui}`,
  letterSpacing: 1,
  color: colors.accentCyanSoft,
  border: `1px solid rgba(95,220,255,.35)`,
  padding: '4px 7px',
  borderRadius: 4,
  maxWidth: 120,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'center',
};
const trackStyle: CSSProperties = { height: 6, borderRadius: 3, background: 'rgba(20,50,64,.7)', overflow: 'hidden', marginTop: 18 };
const sectionLabelStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
const secondaryActionStyle: CSSProperties = {
  textAlign: 'center',
  cursor: 'pointer',
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: 1.5,
  color: '#bff4ff',
  border: '1px solid rgba(95,220,255,.45)',
  padding: '10px 0',
  borderRadius: 8,
  background: 'rgba(23,184,216,.1)',
  width: 'fit-content',
  paddingLeft: 18,
  paddingRight: 18,
};
const dangerActionStyle: CSSProperties = {
  textAlign: 'center',
  cursor: 'pointer',
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: 1.5,
  color: colors.dangerSoft,
  border: '1px solid rgba(255,120,120,.4)',
  padding: '10px 0',
  borderRadius: 8,
  background: 'rgba(255,120,120,.08)',
  width: 'fit-content',
  paddingLeft: 18,
  paddingRight: 18,
};
