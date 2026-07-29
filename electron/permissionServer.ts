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

export interface StartPermissionServerOptions {
  port: number;
  timeoutMs: number;
  onPermissionRequest: (req: { toolName: string; toolInput: unknown }) => Promise<PermissionDecision>;
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

export function startPermissionServer(options: StartPermissionServerOptions): Promise<{ server: http.Server; port: number; stop: () => void }> {
  const server = http.createServer(async (req, res) => {
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
    server.listen(options.port);
  });
}
