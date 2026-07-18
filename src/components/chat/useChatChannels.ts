import { useEffect, useMemo, useRef, useState } from 'react';
import type { AetherState } from '../../state/types';
import { AETHER_CHANNEL_ID, deriveChannels, findChannel, type ChatChannel } from './chatChannels';
import { appendChannelMessage, loadChannelMessages, type ChatMessage } from './chatPersistence';
import { askClaude, toRecentTurns } from './claudeClient';
import { localResponder } from './localResponder';
import { buildSystemPrompt } from './systemPrompt';
import { nowShort } from '../../utils/format';

function makeMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface UseChatChannelsResult {
  channels: ChatChannel[];
  activeChannel: ChatChannel;
  activeChannelId: string;
  setActiveChannelId: (id: string) => void;
  messages: ChatMessage[];
  isTyping: boolean;
  unreadCounts: Record<string, number>;
  sendMessage: (text: string) => void;
}

// Owns the one piece of view-local, non-AetherState state this plan
// establishes as its own concept: which chat channel is currently open. This
// is deliberately NOT `state.selected`/`SELECT_AGENT` (that's "which agent is
// selected" for Grid/Agents) — Chat's "which channel is open" is a different
// axis entirely and would be wrong to conflate just because both happen to
// name an agent. See Global Constraints.
export function useChatChannels(state: AetherState): UseChatChannelsResult {
  const channels = useMemo(() => deriveChannels(state), [state.agents, state.idleList]);
  const [activeChannelId, setActiveChannelId] = useState<string>(AETHER_CHANNEL_ID);
  const [messagesByChannel, setMessagesByChannel] = useState<Record<string, ChatMessage[]>>({});
  const [typingChannelIds, setTypingChannelIds] = useState<Set<string>>(new Set());
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});

  // Tracked in a ref (not read from the `activeChannelId` state closure)
  // because a reply can resolve well after the user has switched to a
  // different channel — the unread bump below must check which channel is
  // open *at resolution time*, not at send time.
  const activeChannelIdRef = useRef(activeChannelId);
  useEffect(() => {
    activeChannelIdRef.current = activeChannelId;
  }, [activeChannelId]);

  // Lazy-load a channel's history from its own localStorage key the first
  // time it's opened, and clear its unread badge on open.
  useEffect(() => {
    setMessagesByChannel((prev) => (prev[activeChannelId] ? prev : { ...prev, [activeChannelId]: loadChannelMessages(activeChannelId) }));
    setUnreadCounts((prev) => (prev[activeChannelId] ? { ...prev, [activeChannelId]: 0 } : prev));
  }, [activeChannelId]);

  const activeChannel = findChannel(channels, activeChannelId) ?? channels[0];

  function sendMessage(rawText: string) {
    const text = rawText.trim();
    if (!text || activeChannel.archived) return;
    const channel = activeChannel;
    const channelId = channel.id;

    const userMsg: ChatMessage = { id: makeMessageId(), role: 'user', text, t: nowShort() };
    const historyWithUserMsg = appendChannelMessage(channelId, messagesByChannel[channelId] ?? [], userMsg);
    setMessagesByChannel((prev) => ({ ...prev, [channelId]: historyWithUserMsg }));
    setTypingChannelIds((prev) => new Set(prev).add(channelId));

    // Phase 2a's real Persona + live-state-snapshot + Rules system prompt.
    // Everything below this line (askClaude call, catch, localResponder
    // fallback, persistence, unread bookkeeping) is unchanged from Phase 1.
    const system = buildSystemPrompt(channel, state);

    askClaude(system, toRecentTurns(historyWithUserMsg))
      .catch(() => null)
      .then((reply) => {
        const finalText = reply ?? `[offline] ${localResponder(channel, text, state)}`;
        const assistantMsg: ChatMessage = { id: makeMessageId(), role: 'assistant', text: finalText, t: nowShort() };
        setMessagesByChannel((prev) => ({
          ...prev,
          [channelId]: appendChannelMessage(channelId, prev[channelId] ?? historyWithUserMsg, assistantMsg),
        }));
        setTypingChannelIds((prev) => {
          const next = new Set(prev);
          next.delete(channelId);
          return next;
        });
        setUnreadCounts((prev) => (channelId === activeChannelIdRef.current ? prev : { ...prev, [channelId]: (prev[channelId] ?? 0) + 1 }));
      });
  }

  return {
    channels,
    activeChannel,
    activeChannelId: activeChannel.id,
    setActiveChannelId,
    messages: messagesByChannel[activeChannel.id] ?? [],
    isTyping: typingChannelIds.has(activeChannel.id),
    unreadCounts,
    sendMessage,
  };
}
