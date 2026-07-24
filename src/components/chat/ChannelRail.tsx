import { useState, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import type { ChatChannel } from './chatChannels';
import type { RealAgentDispatch } from '../../state/liveAgentsMath';
import type { DispatchChannelStub } from '../../state/types';

interface ChannelRailProps {
  channels: ChatChannel[];
  activeChannelId: string;
  unreadCounts: Record<string, number>;
  onSelect: (id: string) => void;
  recentCompletedDispatches: RealAgentDispatch[];
  dispatchChannels: DispatchChannelStub[];
  onCreateDispatchChannel: (toolUseId: string) => void;
  onRemoveDispatchChannel: (toolUseId: string) => void;
}

export function ChannelRail({
  channels,
  activeChannelId,
  unreadCounts,
  onSelect,
  recentCompletedDispatches,
  dispatchChannels,
  onCreateDispatchChannel,
  onRemoveDispatchChannel,
}: ChannelRailProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const poolable = recentCompletedDispatches.filter((d) => !dispatchChannels.some((c) => c.toolUseId === d.toolUseId));

  return (
    <div style={railStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>CHANNELS</div>
        <span onClick={() => setPickerOpen((o) => !o)} style={newButtonStyle}>
          + NEW
        </span>
      </div>

      {pickerOpen && (
        <div style={pickerStyle}>
          {poolable.length === 0 && <div style={pickerEmptyStyle}>no completed dispatches to start a channel for</div>}
          {poolable.map((d) => (
            <div
              key={d.toolUseId}
              onClick={() => {
                onCreateDispatchChannel(d.toolUseId);
                setPickerOpen(false);
              }}
              style={pickerRowStyle}
            >
              <div style={pickerNameStyle}>{d.description || d.subagentType}</div>
              <div style={pickerTypeStyle}>{d.subagentType}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {channels.map((c) => {
          const on = c.id === activeChannelId;
          const unread = unreadCounts[c.id] ?? 0;
          return (
            <div key={c.id} onClick={() => onSelect(c.id)} style={rowStyle(on, c.archived)}>
              <span style={avatarStyle(c.hue)}>{c.initials}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={nameStyle(c.archived)}>{c.name}</div>
                {c.archived && <div style={terminatedTagStyle}>TERMINATED</div>}
              </div>
              {!!unread && <span style={unreadBadgeStyle}>{unread}</span>}
              {c.kind === 'dispatch' && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveDispatchChannel(c.toolUseId!);
                  }}
                  style={removeStyle}
                >
                  ×
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const railStyle: CSSProperties = {
  width: 220,
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
const newButtonStyle: CSSProperties = {
  cursor: 'pointer',
  font: `600 9px/1 ${fonts.ui}`,
  letterSpacing: 1,
  padding: '5px 9px',
  borderRadius: 6,
  color: '#04202b',
  background: 'linear-gradient(180deg,#7ef0ff,#17b8d8)',
};
const pickerStyle: CSSProperties = {
  marginTop: 10,
  padding: 8,
  borderRadius: 9,
  border: `1px solid ${colors.chipBorder}`,
  background: 'rgba(6,20,28,.6)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};
const pickerEmptyStyle: CSSProperties = { font: `400 10px/1.3 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
const pickerRowStyle: CSSProperties = { cursor: 'pointer', padding: '5px 6px', borderRadius: 6 };
const pickerNameStyle: CSSProperties = {
  font: `600 11px/1.3 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const pickerTypeStyle: CSSProperties = { font: `400 9px/1.3 ${fonts.mono}`, color: colors.textDim, marginTop: 1 };
function rowStyle(on: boolean, archived: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    padding: '8px 9px',
    borderRadius: 9,
    cursor: 'pointer',
    opacity: archived ? 0.55 : 1,
    background: on ? 'rgba(23,184,216,.14)' : undefined,
    border: on ? '1px solid rgba(95,220,255,.4)' : '1px solid transparent',
  };
}
function avatarStyle(hue: string): CSSProperties {
  return {
    width: 26,
    height: 26,
    flex: 'none',
    borderRadius: 7,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 4px,#123f4e 4px 8px)',
    border: `1px solid ${hue}`,
    display: 'grid',
    placeItems: 'center',
    font: `700 10px/1 ${fonts.mono}`,
    color: hue,
  };
}
function nameStyle(archived: boolean): CSSProperties {
  return {
    font: `600 13px/1 ${fonts.ui}`,
    color: archived ? colors.textMuted : colors.textPrimary,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}
const terminatedTagStyle: CSSProperties = { marginTop: 2, font: `600 8px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textDim };
const unreadBadgeStyle: CSSProperties = {
  flex: 'none',
  minWidth: 16,
  height: 16,
  padding: '0 4px',
  borderRadius: 8,
  background: colors.accentCyanDeep,
  color: '#04202b',
  font: `700 10px/16px ${fonts.mono}`,
  textAlign: 'center',
};
const removeStyle: CSSProperties = { flex: 'none', cursor: 'pointer', font: `700 13px/1 ${fonts.ui}`, color: colors.dangerSoft, padding: '2px 5px' };
