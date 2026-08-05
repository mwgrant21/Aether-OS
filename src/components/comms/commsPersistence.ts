export interface ChatMessage {
  id: string;
  // 'system' is reserved for a future (Phase 2) action-confirmation/denial
  // line inserted by the action-execution pipeline — Phase 1 only ever
  // produces 'user' and 'assistant' messages, but the type carries the third
  // option now so Phase 2 doesn't need to touch this shape.
  role: 'user' | 'assistant' | 'system';
  text: string;
  t: string;
}

export const MAX_MESSAGES_PER_CHANNEL = 50;

function storageKey(channelId: string): string {
  return `aether-chat-${channelId}`;
}

export function loadChannelMessages(channelId: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(storageKey(channelId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

export function saveChannelMessages(channelId: string, messages: ChatMessage[]): void {
  try {
    localStorage.setItem(storageKey(channelId), JSON.stringify(messages.slice(-MAX_MESSAGES_PER_CHANNEL)));
  } catch {
    // localStorage unavailable (private mode, quota) — same best-effort precedent as state/persistence.ts
  }
}

export function appendChannelMessage(channelId: string, existing: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const next = [...existing, message].slice(-MAX_MESSAGES_PER_CHANNEL);
  saveChannelMessages(channelId, next);
  return next;
}
