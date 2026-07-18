import type { ChatMessage } from './chatPersistence';

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

const RECENT_TURN_LIMIT = 10;

// Trims a channel's message history down to the last N user/assistant turns
// (dropping any reserved 'system' entries) for the shape askClaude expects.
export function toRecentTurns(messages: ChatMessage[], limit: number = RECENT_TURN_LIMIT): ChatTurn[] {
  return messages
    .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
    .slice(-limit)
    .map((m) => ({ role: m.role, text: m.text }));
}

// Calls the Vite dev-server middleware proxy (Task 5's POST /api/chat),
// which forwards { system, messages } to the Anthropic Messages API
// server-side -- the API key never reaches this client-side code. Returns
// the reply string on success, or null on ANY failure (network error,
// non-2xx status, missing/empty reply field, malformed response body) so
// useChatChannels.ts's existing "fall back to localResponder on null" branch
// (unchanged from Phase 1) is always safe to await unconditionally.
export async function askClaude(system: string, messages: ChatTurn[]): Promise<string | null> {
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system, messages }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { reply?: unknown };
    return typeof data.reply === 'string' && data.reply.length > 0 ? data.reply : null;
  } catch {
    return null;
  }
}
