// NOTE: unlike the rest of src/shared/ (pure logic imported by both main and renderer),
// this module must NEVER be imported by renderer code. It wraps @anthropic-ai/sdk and
// reads no key itself, but importing it into the renderer would bundle the SDK there and
// put key handling one refactor away from running in the wrong process.
import Anthropic from '@anthropic-ai/sdk';
import { resolveModel } from './modelPolicy';

export const CHAT_MAX_TOKENS = 300;

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatRequestBody {
  system: string;
  messages: ChatTurn[];
}

export type ChatCoreResult =
  | { ok: true; reply: string; usage: { inputTokens: number; outputTokens: number } }
  | { ok: false; status: 400 | 500 | 503; error: string };

function isChatTurn(value: unknown): value is ChatTurn {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v.role === 'user' || v.role === 'assistant') && typeof v.text === 'string';
}

export function isValidChatBody(body: unknown): body is ChatRequestBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.system !== 'string') return false;
  if (!Array.isArray(b.messages) || b.messages.length === 0) return false;
  return b.messages.every(isChatTurn);
}

// Narrows a response content block to the text-bearing variant. Confirmed
// against the installed @anthropic-ai/sdk (0.112.3) types: `ContentBlock` is
// a union (TextBlock | ThinkingBlock | ToolUseBlock | ...) and only
// `Anthropic.TextBlock` carries `{ type: 'text', text: string }`.
function isTextBlock(block: Anthropic.ContentBlock): block is Anthropic.TextBlock {
  return block.type === 'text';
}

// Transport-agnostic core of the chat proxy: takes an already-parsed request
// body and the caller-supplied API key, and talks to Anthropic directly.
// Parsing raw JSON off the wire (and any malformed-JSON handling) stays in
// the HTTP adapter, since that's a transport concern, not a core one.
export async function runChatRequest(
  body: unknown,
  apiKey: string | undefined,
  model: string = resolveModel('chat'),
  maxTokens: number = CHAT_MAX_TOKENS
): Promise<ChatCoreResult> {
  if (!isValidChatBody(body)) {
    return { ok: false, status: 400, error: 'body must be { system: string, messages: {role, text}[] }' };
  }

  if (!apiKey) {
    // Deliberately a clear, non-crashing error status -- askClaude() (Task 6)
    // treats any non-2xx as a signal to return null and fall back to
    // localResponder. The dev server itself never crashes on a missing key.
    return { ok: false, status: 503, error: 'ANTHROPIC_API_KEY is not set on the server' };
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: body.system,
      messages: body.messages.map((m) => ({ role: m.role, content: m.text })),
    });
    const textBlock = response.content.find(isTextBlock);
    return {
      ok: true,
      reply: textBlock?.text ?? '',
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  } catch (err) {
    // Never let an Anthropic SDK error (rate limit, auth, network, etc.)
    // crash the caller -- surface it as a clean 500 and let askClaude()
    // fall back to localResponder.
    return { ok: false, status: 500, error: err instanceof Error ? err.message : 'unknown error calling Anthropic' };
  }
}
