import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import type { ChatChannel } from './chatChannels';

interface ChannelRailProps {
  channels: ChatChannel[];
  activeChannelId: string;
  unreadCounts: Record<string, number>;
  onSelect: (id: string) => void;
}

export function ChannelRail({ channels, activeChannelId, unreadCounts, onSelect }: ChannelRailProps) {
  return (
    <div style={railStyle}>
      <div style={titleStyle}>CHANNELS</div>
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
