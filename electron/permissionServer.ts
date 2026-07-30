import http from 'node:http';
import type { PermissionRisk } from '../src/shared/permissionRisk';

export interface PermissionRequestPayload {
  requestId: string;
  toolName: string;
  toolInput: unknown;
  risk: PermissionRisk;
}

export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  reason?: string;
}

export interface PostToolFlagDecision {
  block: boolean;
  reason?: string;
}

export interface StartPermissionServerOptions {
  port: number;
  timeoutMs: number;
  onPermissionRequest: (req: { toolName: string; toolInput: unknown }) => Promise<PermissionDecision>;
  // Both optional: existing callers (and existing tests) that only care about
  // PermissionRequest never need to know this route exists.
  onPostToolUse?: (req: { toolUseId: string; toolName: string; toolOutput: unknown }) => Promise<PostToolFlagDecision>;
  postToolUseTimeoutMs?: number;
  // Fire-and-forget: no decision to return, unlike onPermissionRequest/onPostToolUse.
  onNotification?: (req: { sessionId: string; notificationType: string }) => void;
}

const pendingRequests = new Map<string, (decision: PermissionDecision) => void>();

export function resolvePendingRequest(requestId: string, decision: PermissionDecision): boolean {
  const resolver = pendingRequests.get(requestId);
  if (!resolver) return false;
  pendingRequests.delete(requestId);
  resolver(decision);
  return true;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

// promise can settle in three ways: resolve, reject, or never (timeout). All three
// must converge on a value — a rejected/never-settling promise must never surface
// as an unhandled rejection or a hung connection.
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(onTimeout());
      }
    }, timeoutMs);
    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(onTimeout());
        }
      }
    );
  });
}

// Wraps a call to onPermissionRequest so a *synchronous* throw is converted into a
// rejected promise instead of propagating out of the request handler before
// withTimeout's setTimeout guard is even created.
function invokeSafely(
  onPermissionRequest: StartPermissionServerOptions['onPermissionRequest'],
  req: { toolName: string; toolInput: unknown }
): Promise<PermissionDecision> {
  try {
    return Promise.resolve(onPermissionRequest(req));
  } catch (err) {
    return Promise.reject(err);
  }
}

// Same synchronous-throw-to-rejection guard as invokeSafely above, for the
// /post-tool-flag-check route's callback.
function invokePostToolUseSafely(
  onPostToolUse: NonNullable<StartPermissionServerOptions['onPostToolUse']>,
  req: { toolUseId: string; toolName: string; toolOutput: unknown }
): Promise<PostToolFlagDecision> {
  try {
    return Promise.resolve(onPostToolUse(req));
  } catch (err) {
    return Promise.reject(err);
  }
}

export function startPermissionServer(options: StartPermissionServerOptions): Promise<{ server: http.Server; port: number; stop: () => void }> {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/notification') {
      if (!options.onNotification) {
        res.writeHead(404).end();
        return;
      }
      let notifParsed: { sessionId?: unknown; notificationType?: unknown };
      try {
        notifParsed = JSON.parse(await readBody(req));
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (typeof notifParsed.sessionId !== 'string' || typeof notifParsed.notificationType !== 'string') {
        res.writeHead(400).end();
        return;
      }
      try {
        options.onNotification({ sessionId: notifParsed.sessionId, notificationType: notifParsed.notificationType });
      } catch {
        // Same discipline as invokeSafely elsewhere in this file: a throwing
        // handler must never surface as a broken hook response.
      }
      res.writeHead(200).end();
      return;
    }

    if (req.method === 'POST' && req.url === '/post-tool-flag-check') {
      if (!options.onPostToolUse) {
        res.writeHead(404).end();
        return;
      }

      let flagParsed: { toolUseId?: unknown; toolName?: unknown; toolOutput?: unknown };
      try {
        flagParsed = JSON.parse(await readBody(req));
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (typeof flagParsed.toolUseId !== 'string' || typeof flagParsed.toolName !== 'string') {
        res.writeHead(400).end();
        return;
      }

      const flagDecision = await withTimeout(
        invokePostToolUseSafely(options.onPostToolUse, {
          toolUseId: flagParsed.toolUseId,
          toolName: flagParsed.toolName,
          toolOutput: flagParsed.toolOutput,
        }),
        options.postToolUseTimeoutMs ?? 30000,
        () => ({ block: false, reason: 'post-tool-use review timeout: no decision received in time' })
      );

      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(flagDecision));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/permission-request') {
      res.writeHead(404).end();
      return;
    }

    let parsed: { toolName?: unknown; toolInput?: unknown };
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (typeof parsed.toolName !== 'string') {
      res.writeHead(400).end();
      return;
    }

    const decision = await withTimeout(
      invokeSafely(options.onPermissionRequest, { toolName: parsed.toolName, toolInput: parsed.toolInput }),
      options.timeoutMs,
      () => ({ behavior: 'deny' as const, reason: 'permission request timeout: no decision received in time' })
    );

    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(decision));
  });

  return new Promise((resolve, reject) => {
    // Node's EventEmitter contract rethrows an 'error' event with zero
    // listeners as an uncaught exception on the process -- without this
    // listener, a real bind failure (e.g. EADDRINUSE) would crash the whole
    // Electron main process instead of surfacing as a rejected Promise.
    server.once('error', (err) => {
      reject(err);
    });
    server.once('listening', () => {
      const actualPort = options.port === 0 ? (server.address() as { port: number }).port : options.port;
      resolve({
        server,
        port: actualPort,
        stop: () => server.close(),
      });
    });
    server.listen(options.port, '127.0.0.1');
  });
}
