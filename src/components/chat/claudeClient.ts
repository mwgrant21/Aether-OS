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

// Phase 2 (a separate, future plan) replaces this stub's internals with a
// real call to a Vite dev-server middleware proxy (`POST /api/chat`) that
// forwards `{ system, messages }` to the Anthropic Messages API — never
// exposing the API key client-side. This function's signature, and the
// message-send flow's "on failure, fall back to `localResponder`" branch
// (see `useChatChannels.ts`), are the seam Phase 2 lands on; only what runs
// inside this function's body changes then. In Phase 1 it always resolves to
// `null`, so that fallback path is real, exercised code today, not dead code.
export async function askClaude(_system: string, _messages: ChatTurn[]): Promise<string | null> {
  return null;
}
