import { useEffect, useState, type CSSProperties } from 'react';
import { fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { fmtElapsed } from '../../utils/format';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import type { ColorPalette } from '../../styles/tokens';
import { groupDispatches } from './rosterGrouping';
import { applyNarrationVerbosity } from '../../shared/narrationVerbosity';

export function AgentRosterCard({ selectedToolUseId }: { selectedToolUseId: string | null }) {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const groups = groupDispatches(state.realAgents, state.anomalies, state.recentCompletedDispatches);

  return (
    <div style={cardStyle(colors)}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle(colors)}>AGENT ROSTER</div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {groups.map((group) => (
          group.dispatches.length > 0 && (
            <div key={group.label}>
              <div style={groupHeaderStyle(colors)}>{group.label}</div>
              {group.dispatches.map((a) => {
                const on = a.toolUseId === selectedToolUseId;
                const hasAnomaly = group.label === 'NEEDS INPUT';
                const isDone = group.label === 'DONE';
                const headline = state.dispatchHeadlines[a.toolUseId] ?? a.description;
                const finalDurationMs = state.dispatchUsage[a.toolUseId]?.durationMs;
                const elapsedLabel = isDone
                  ? (finalDurationMs !== undefined ? fmtElapsed(finalDurationMs) : '--')
                  : fmtElapsed(now - new Date(a.startedAt).getTime());
                const rawNarration = state.dispatchNarrations[a.toolUseId];
                const narration = rawNarration
                  ? applyNarrationVerbosity(rawNarration.narration, state.cfg.narrationVerbosity, rawNarration.severity as 0 | 1 | 2 | 3 | 4)
                  : null;
                return (
                  <Button key={a.toolUseId} onClick={() => dispatch({ type: 'SELECT_REAL_AGENT', toolUseId: a.toolUseId })} style={rowStyle(on)}>
                    <span style={glyphStyle(colors, hasAnomaly)} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                        <span style={nameStyle(colors)}>{a.subagentType}</span>
                        <span style={{ font: `700 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>{elapsedLabel}</span>
                      </div>
                      <div style={descStyle(colors)}>{headline}</div>
                      {narration && <div data-testid="narration-line" style={narrationStyle(colors)}>{narration}</div>}
                    </div>
                  </Button>
                );
              })}
            </div>
          )
        ))}
        {!state.realAgents.length && <div style={emptyStyle(colors)}>no agents currently running</div>}
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
function glyphStyle(colors: ColorPalette, hasAnomaly: boolean): CSSProperties {
  return {
    width: 10,
    height: 10,
    borderRadius: '50%',
    flex: 'none',
    background: colors.accentCyanSoft,
    boxShadow: hasAnomaly ? `0 0 0 2px ${colors.warn}` : 'none',
  };
}
function groupHeaderStyle(colors: ColorPalette): CSSProperties {
  return { font: `700 10px/1 ${fonts.ui}`, letterSpacing: 1.5, color: colors.textMuted, margin: '10px 0 4px' };
}
function nameStyle(colors: ColorPalette): CSSProperties {
  return {
    font: `600 13px/1 ${fonts.ui}`,
    color: colors.textPrimary,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}
function descStyle(colors: ColorPalette): CSSProperties {
  return {
    font: `400 11px/1.3 ${fonts.ui}`,
    color: colors.textDim,
    marginTop: 3,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}
function narrationStyle(colors: ColorPalette): CSSProperties {
  return {
    marginTop: 2,
    font: `500 10px/1.4 ${fonts.mono}`,
    color: colors.textMuted,
    fontStyle: 'italic',
  };
}
function emptyStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
}
