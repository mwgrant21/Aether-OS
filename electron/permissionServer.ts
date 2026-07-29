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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(onTimeout());
      }
    }, timeoutMs);
    promise.then((value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    });
  });
}

export function startPermissionServer(options: StartPermissionServerOptions): { server: http.Server; port: number; stop: () => void } {
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
      options.onPermissionRequest({ toolName: parsed.toolName, toolInput: parsed.toolInput }),
      options.timeoutMs,
      () => ({ behavior: 'deny' as const, reason: 'permission request timeout: no decision received in time' })
    );

    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(decision));
  });

  server.listen(options.port);
  const actualPort = options.port === 0 ? (server.address() as { port: number }).port : options.port;

  return {
    server,
    port: actualPort,
    stop: () => server.close(),
  };
}
