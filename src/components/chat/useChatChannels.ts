import { useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import type { AetherState } from '../../state/types';
import type { Action } from '../../state/reducer';
import { AETHER_CHANNEL_ID, deriveChannels, findChannel, type ChatChannel } from './chatChannels';
import { appendChannelMessage, loadChannelMessages, type ChatMessage } from './chatPersistence';
import { askClaude, toRecentTurns } from './claudeClient';
import { localResponder } from './localResponder';
import { buildSystemPrompt } from './systemPrompt';
import { parseActionLine, type ChatAction } from './actionParser';
import { SAFE_VERBS, RISKY_VERBS, buildSafeCommandRaw, buildApprovalPayload, shouldAutoApprove } from './actionExecutor';
import { runCommand } from '../terminal/commands';
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
export function useChatChannels(state: AetherState, dispatch: Dispatch<Action>): UseChatChannelsResult {
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
        // The action-JSON convention is only ever meaningful for a genuine
        // Claude reply -- localResponder's [offline] fallback text is inert
        // canned prose and is never parsed (see Global Constraints).
        let displayText: string;
        let action: ChatAction | null = null;
        if (reply != null) {
          const parsed = parseActionLine(reply);
          displayText = parsed.text;
          action = parsed.action;
        } else {
          displayText = `[offline] ${localResponder(channel, text, state)}`;
        }

        const assistantMsg: ChatMessage = { id: makeMessageId(), role: 'assistant', text: displayText, t: nowShort() };

        // Any system confirmation line to append alongside the assistant
        // reply (safe-verb execution only -- risky verbs never post an
        // inline line here, see below). Computed as a side value rather than
        // mutating message state directly so the actual setMessagesByChannel
        // call below can stay a functional updater over the freshest `prev`
        // (which, by the time this reply resolves, already reflects the
        // user's own message committed synchronously above).
        let sysConfirmMsg: ChatMessage | null = null;

        // Dispatch channels never invite the action-JSON convention (their system
        // prompt omits it entirely -- see systemPrompt.ts's buildDispatchPrompt) and
        // never execute one even if a reply contained action-shaped JSON anyway --
        // none of spawn/kill/theme/renderer/throttle have a real-world meaning for a
        // completed real dispatch, and channel.name for a dispatch channel is a task
        // description, not a valid fictional agent name.
        if (action && channel.kind !== 'dispatch') {
          if ((SAFE_VERBS as readonly string[]).includes(action.verb)) {
            const raw = buildSafeCommandRaw(action);
            if (raw) {
              const result = runCommand(state, raw);
              if (result.kind === 'append' && result.patch) {
                dispatch({ type: 'RUN_COMMAND', raw });
                const confirmLine = result.lines[1]?.t ?? `✓ ${raw} applied.`;
                sysConfirmMsg = { id: makeMessageId(), role: 'system', text: confirmLine, t: nowShort() };
              }
              // Invalid args (defensively re-checked by runCommand) -> silent
              // no-op: the prose reply still displays; nothing executes.
            }
          } else if ((RISKY_VERBS as readonly string[]).includes(action.verb)) {
            const payload = buildApprovalPayload(channel, action);
            if (payload) {
              // Single dispatch: the reducer assigns the id and, when
              // autoResolve is set, resolves it atomically in the same
              // dispatch -- no id is predicted across dispatches here, so a
              // concurrent tick-generated approval can never shift apprSeq
              // out from under this one (see reducer.ts's ADD_APPROVAL case
              // and applyApprovalResolution).
              dispatch({ type: 'ADD_APPROVAL', approval: payload, autoResolve: shouldAutoApprove(payload.risk, state.cfg.opMode) });
              // No inline "queued" confirmation here -- the one, single
              // source of truth for a risky verb's outcome (auto-approved,
              // manually approved later, or denied later) is the
              // chatActionResults drain effect below, fed exclusively by
              // RESOLVE_APPROVAL. This avoids ever double-messaging a
              // channel about the same resolution.
            }
          }
        }

        setMessagesByChannel((prev) => {
          let next = appendChannelMessage(channelId, prev[channelId] ?? historyWithUserMsg, assistantMsg);
          if (sysConfirmMsg) next = appendChannelMessage(channelId, next, sysConfirmMsg);
          return { ...prev, [channelId]: next };
        });
        setTypingChannelIds((prev) => {
          const next = new Set(prev);
          next.delete(channelId);
          return next;
        });
        setUnreadCounts((prev) => (channelId === activeChannelIdRef.current ? prev : { ...prev, [channelId]: (prev[channelId] ?? 0) + 1 }));
      });
  }

  // Bridges an approval resolved from anywhere else in the app (TopBar's
  // global approval bell, or the Agents tab's per-agent card -- both dispatch
  // the same RESOLVE_APPROVAL this hook never touches directly) back into the
  // chat channel that requested it. Runs whenever state.chatActionResults
  // changes -- correctly picks up a resolution that happened while this very
  // channel was open (the common case, since TopBar's bell is global chrome)
  // as well as one that happened while Chat wasn't mounted at all (drained
  // lazily the next time Chat opens, since per-channel history is lazily
  // hydrated from localStorage on open regardless).
  useEffect(() => {
    if (!state.chatActionResults.length) return;
    const results = state.chatActionResults;
    setMessagesByChannel((prev) => {
      let next = prev;
      for (const result of results) {
        const sysMsg: ChatMessage = { id: makeMessageId(), role: 'system', text: result.text, t: nowShort() };
        const existing = next[result.channelId] ?? loadChannelMessages(result.channelId);
        next = { ...next, [result.channelId]: appendChannelMessage(result.channelId, existing, sysMsg) };
      }
      return next;
    });
    setUnreadCounts((prev) => {
      const next = { ...prev };
      for (const result of results) {
        if (result.channelId !== activeChannelIdRef.current) next[result.channelId] = (next[result.channelId] ?? 0) + 1;
      }
      return next;
    });
    dispatch({ type: 'CLEAR_CHAT_ACTION_RESULTS', count: results.length });
  }, [state.chatActionResults, dispatch]);

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
