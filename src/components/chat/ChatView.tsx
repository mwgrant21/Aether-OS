import { useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { useChatChannels } from './useChatChannels';
import { useChatBackendState, type ChatBackendState } from './useChatBackendState';
import { ChannelRail } from './ChannelRail';
import { MessageThread } from './MessageThread';
import { MessageInput } from './MessageInput';

const CHIP_LABEL: Record<ChatBackendState, string> = {
  live: 'LIVE',
  offline: 'OFFLINE',
  browser: 'BROWSER',
};

const CHIP_TITLE: Record<ChatBackendState, string> = {
  live: 'Claude replies enabled',
  offline: 'Not confirmed live — replies may fall back to the offline in-world responder',
  browser: 'Browser mode — replies via the dev-server proxy',
};

export function ChatView() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const chat = useChatChannels(state, dispatch);
  const [draft, setDraft] = useState('');
  const backendState = useChatBackendState();

  function send() {
    if (!draft.trim()) return;
    chat.sendMessage(draft);
    setDraft('');
  }

  return (
    <div style={rootStyle}>
      <ChannelRail
        channels={chat.channels}
        activeChannelId={chat.activeChannelId}
        unreadCounts={chat.unreadCounts}
        onSelect={chat.setActiveChannelId}
        recentCompletedDispatches={state.recentCompletedDispatches}
        dispatchChannels={state.dispatchChannels}
        onCreateDispatchChannel={(toolUseId) => dispatch({ type: 'CREATE_DISPATCH_CHANNEL', toolUseId })}
        onRemoveDispatchChannel={(toolUseId) => dispatch({ type: 'REMOVE_DISPATCH_CHANNEL', toolUseId })}
      />
      <div style={mainStyle(colors)}>
        <div style={headerStyle(colors)}>
          <span style={headerDotStyle(chat.activeChannel.hue)} />
          <span style={headerNameStyle(colors)}>{chat.activeChannel.name}</span>
          {chat.activeChannel.archived && <span style={archivedPillStyle(colors)}>TERMINATED</span>}
          {backendState !== null && (
            <span style={backendChipStyle(colors, backendState)} title={CHIP_TITLE[backendState]}>
              {CHIP_LABEL[backendState]}
            </span>
          )}
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
function mainStyle(colors: ColorPalette): CSSProperties {
  return {
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
}
function headerStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    paddingBottom: 12,
    borderBottom: `1px solid ${colors.chromeBorder}`,
  };
}
function headerDotStyle(hue: string): CSSProperties {
  return { width: 8, height: 8, borderRadius: '50%', background: hue, boxShadow: `0 0 8px ${hue}` };
}
function headerNameStyle(colors: ColorPalette): CSSProperties {
  return { font: `700 15px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textPrimary };
}
function archivedPillStyle(colors: ColorPalette): CSSProperties {
  return {
    font: `600 9px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: colors.textDim,
    border: `1px solid ${colors.chromeBorder}`,
    padding: '3px 7px',
    borderRadius: 5,
  };
}
function backendChipStyle(colors: ColorPalette, backendState: ChatBackendState): CSSProperties {
  return {
    marginLeft: 'auto',
    font: `600 9px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: backendState === 'live' ? colors.success : backendState === 'offline' ? colors.warn : colors.textDim,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelInset,
    padding: '3px 7px',
    borderRadius: 5,
  };
}
