import { useMemo, useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { useCommsChannels } from './useCommsChannels';
import { useTranscriptSource } from './useTranscriptSource';
import { ChannelRail } from './ChannelRail';
import { MessageThread } from './MessageThread';
import { MessageInput } from './MessageInput';
import { parseFilter, applyFilter, type DisplayMessage } from './transcriptFilter';
import { localResponder } from './localResponder';

function makeMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function CommsView() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const chat = useCommsChannels(state, dispatch);
  const [filterValue, setFilterValue] = useState('');
  // localResponder replies, kept per the design doc's "What happens to
  // localResponder" decision (kept, as the AETHER channel's fallback for
  // non-filter input). These are synthetic DisplayMessage entries, not
  // transcript content, so they live in this component's own useState right
  // alongside the transcript messages they're interleaved with -- same
  // render-not-store discipline, see src/state/noPayloadInStore.test.ts.
  const [localReplies, setLocalReplies] = useState<Record<string, DisplayMessage[]>>({});

  const source = useTranscriptSource(chat.activeChannel.transcriptSourceId);

  const filter = useMemo(() => parseFilter(filterValue), [filterValue]);
  const combinedMessages = useMemo(() => {
    const extra = localReplies[chat.activeChannelId] ?? [];
    if (!extra.length) return source.messages;
    return [...source.messages, ...extra].sort((a, b) => a.atMs - b.atMs);
  }, [source.messages, localReplies, chat.activeChannelId]);
  const visibleMessages = useMemo(() => applyFilter(combinedMessages, filter), [combinedMessages, filter]);

  function onFilterSubmit() {
    const text = filterValue.trim();
    if (!text) return;
    // Only the AETHER channel gets a localResponder reply, and only when the
    // text isn't a /tool /human /error filter expression -- those still just
    // narrow the thread, per the task-3 brief.
    if (chat.activeChannel.kind === 'aether' && (filter.type === 'text' || filter.type === 'empty')) {
      const replyText = localResponder(chat.activeChannel, text, state);
      const humanMsg: DisplayMessage = { id: makeMessageId(), role: 'human', atMs: Date.now(), text, toolCalls: [], toolResults: [] };
      const assistantMsg: DisplayMessage = {
        id: makeMessageId(),
        role: 'assistant',
        atMs: Date.now() + 1,
        text: replyText,
        toolCalls: [],
        toolResults: [],
      };
      const channelId = chat.activeChannelId;
      setLocalReplies((prev) => ({ ...prev, [channelId]: [...(prev[channelId] ?? []), humanMsg, assistantMsg] }));
      setFilterValue('');
    }
  }

  const statusLabel = !chat.activeChannel.transcriptSourceId ? 'ENDED' : source.isLive ? 'LIVE' : 'REPLAY';

  return (
    <div style={rootStyle}>
      <ChannelRail
        channels={chat.channels}
        activeChannelId={chat.activeChannelId}
        unreadCounts={chat.unreadCounts}
        onSelect={(id) => {
          chat.setActiveChannelId(id);
          setFilterValue('');
        }}
        recentCompletedDispatches={state.recentCompletedDispatches}
        dispatchChannels={state.dispatchChannels}
        onCreateDispatchChannel={(toolUseId) => dispatch({ type: 'CREATE_DISPATCH_CHANNEL', toolUseId })}
        onRemoveDispatchChannel={(toolUseId) => dispatch({ type: 'REMOVE_DISPATCH_CHANNEL', toolUseId })}
      />
      <div style={mainStyle(colors)}>
        <div style={headerStyle(colors)}>
          <span style={headerDotStyle(chat.activeChannel.hue)} />
          <span style={headerNameStyle(colors)}>{chat.activeChannel.name}</span>
          <span style={statusPillStyle(colors, statusLabel)}>{statusLabel}</span>
        </div>
        <MessageThread
          channel={chat.activeChannel}
          messages={visibleMessages}
          narrationMessages={state.narrationMessages[chat.activeChannelId] ?? []}
        />
        <MessageInput
          value={filterValue}
          onChange={setFilterValue}
          onSubmit={onFilterSubmit}
          placeholder={`Filter ${chat.activeChannel.name}… (/tool, /human, /error)`}
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
function statusPillStyle(colors: ColorPalette, label: string): CSSProperties {
  return {
    font: `600 9px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: label === 'LIVE' ? colors.accentCyan : colors.textDim,
    border: `1px solid ${label === 'LIVE' ? colors.accentCyan : colors.chromeBorder}`,
    padding: '3px 7px',
    borderRadius: 5,
  };
}
