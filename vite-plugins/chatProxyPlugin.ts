import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { runChatRequest } from '../src/shared/chatCore';

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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
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

  // Deliberately dev-only and ungated: this plugin only runs under the Vite
  // dev server (`npm run dev`, browser-mode chat). It has no access to the
  // Electron main process's policy-mode state or spend tracker (those live
  // in electron/main.ts), so it cannot be wired into the Local/API/Off gate
  // or modelSpendTracker without duplicating that machinery in a dev-only
  // Vite plugin -- not worth it for a path that never ships. Not a
  // production risk, but real: it is a genuine, unaudited model-call site,
  // tracked as such rather than silently assumed away.
  const result = await runChatRequest(parsed, process.env.ANTHROPIC_API_KEY);
  if (result.ok) {
    sendJson(res, 200, { reply: result.reply });
  } else {
    sendJson(res, result.status, { error: result.error });
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
