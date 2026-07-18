import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 300;

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

interface ChatRequestBody {
  system: string;
  messages: ChatTurn[];
}

// Vite's connect-style dev server has no built-in JSON body parser (unlike
// Express's express.json()) -- the raw request body must be collected
// manually from the stream before it can be parsed.
export function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// Narrows a response content block to the text-bearing variant. Confirmed
// against the installed @anthropic-ai/sdk (0.112.3) types: `ContentBlock` is
// a union (TextBlock | ThinkingBlock | ToolUseBlock | ...) and only
// `Anthropic.TextBlock` carries `{ type: 'text', text: string }`.
function isTextBlock(block: Anthropic.ContentBlock): block is Anthropic.TextBlock {
  return block.type === 'text';
}

async function handleChatRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  let parsed: unknown;
  try {
    const raw = await readRequestBody(req);
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'malformed JSON body' });
    return;
  }

  if (!isValidChatBody(parsed)) {
    sendJson(res, 400, { error: 'body must be { system: string, messages: {role, text}[] }' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Deliberately a clear, non-crashing error status -- askClaude() (Task 6)
    // treats any non-2xx as a signal to return null and fall back to
    // localResponder. The dev server itself never crashes on a missing key.
    sendJson(res, 503, { error: 'ANTHROPIC_API_KEY is not set on the server' });
    return;
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: parsed.system,
      messages: parsed.messages.map((m) => ({ role: m.role, content: m.text })),
    });
    const textBlock = response.content.find(isTextBlock);
    sendJson(res, 200, { reply: textBlock?.text ?? '' });
  } catch (err) {
    // Never let an Anthropic SDK error (rate limit, auth, network, etc.)
    // crash the dev server -- surface it as a clean 500 and let askClaude()
    // fall back to localResponder.
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'unknown error calling Anthropic' });
  }
}

export function chatProxyPlugin(): Plugin {
  return {
    name: 'aether-chat-proxy',
    configureServer(server) {
      const middleware: Connect.NextHandleFunction = (req, res) => {
        handleChatRequest(req, res).catch((err) => {
          sendJson(res, 500, { error: err instanceof Error ? err.message : 'unknown error' });
        });
      };
      server.middlewares.use('/api/chat', middleware);
    },
  };
}
