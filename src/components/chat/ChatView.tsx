import { useState, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useChatChannels } from './useChatChannels';
import { ChannelRail } from './ChannelRail';
import { MessageThread } from './MessageThread';
import { MessageInput } from './MessageInput';

export function ChatView() {
  const { state, dispatch } = useAetherStore();
  const chat = useChatChannels(state, dispatch);
  const [draft, setDraft] = useState('');

  function send() {
    if (!draft.trim()) return;
    chat.sendMessage(draft);
    setDraft('');
  }

  return (
    <div style={rootStyle}>
      <ChannelRail channels={chat.channels} activeChannelId={chat.activeChannelId} unreadCounts={chat.unreadCounts} onSelect={chat.setActiveChannelId} />
      <div style={mainStyle}>
        <div style={headerStyle}>
          <span style={headerDotStyle(chat.activeChannel.hue)} />
          <span style={headerNameStyle}>{chat.activeChannel.name}</span>
          {chat.activeChannel.archived && <span style={archivedPillStyle}>TERMINATED</span>}
        </div>
        <MessageThread channel={chat.activeChannel} messages={chat.messages} isTyping={chat.isTyping} />
        <MessageInput
          value={draft}
          onChange={setDraft}
          onSend={send}
          disabled={chat.activeChannel.archived}
          placeholder={chat.activeChannel.archived ? 'This channel is archived — read only' : `Message ${chat.activeChannel.name}…`}
        />
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
const mainStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  padding: 16,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
};
const headerStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  paddingBottom: 12,
  borderBottom: `1px solid ${colors.chromeBorder}`,
};
function headerDotStyle(hue: string): CSSProperties {
  return { width: 8, height: 8, borderRadius: '50%', background: hue, boxShadow: `0 0 8px ${hue}` };
}
const headerNameStyle: CSSProperties = { font: `700 15px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textPrimary };
const archivedPillStyle: CSSProperties = {
  font: `600 9px/1 ${fonts.ui}`,
  letterSpacing: 1,
  color: colors.textDim,
  border: `1px solid ${colors.chromeBorder}`,
  padding: '3px 7px',
  borderRadius: 5,
};
