// @vitest-environment node
//
// This suite exercises real node:stream PassThrough instances standing in for
// child process stdio. The project's default vitest environment is jsdom
// (see vite.config.ts) for the React app; jsdom's patched timer/microtask
// globals were observed to prevent PassThrough 'data' events from ever
// firing here, hanging every test until the 5s timeout. Force the plain
// node environment for this file only.
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AcpClient } from './acpClient';

type AcpRequest = { id: number; method: string; params?: unknown };

type FakeChild = {
  stdout: PassThrough;
  stdin: PassThrough;
  kill: () => void;
  _responders: Array<(req: AcpRequest) => void>;
  /** Every request the client actually put on the wire, in order. Lets tests
   *  assert on what was NOT sent (notably: `authenticate` must never appear
   *  after a passive probe). */
  received: AcpRequest[];
};

/** The real Codex ACP adapter (v1.1.14) InitializeResponse shape,
 *  captured from a live handshake: `api-key` is always offered unconditionally
 *  and `chat-gpt` is offered whenever NO_BROWSER is unset in the child env
 *  (which Aether never sets). */
const REAL_INITIALIZE_RESULT = {
  protocolVersion: 1,
  authMethods: [
    { id: 'api-key', name: 'API Key', description: 'Use an API key to authenticate' },
    { id: 'chat-gpt', name: 'ChatGPT', description: 'Use ChatGPT to authenticate' },
  ],
};

function fakeChild(): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const emitter = new EventEmitter() as unknown as FakeChild;
  emitter.stdout = stdout;
  emitter.stdin = stdin;
  emitter.kill = vi.fn();
  emitter.received = [];
  // A single persistent listener dispatches queued responders in FIFO order,
  // one per incoming request line. Using stdin.once('data', ...) per
  // respondTo() call is unsafe here: registering two `once` listeners before
  // any write occurs means a single 'data' emission notifies BOTH of them
  // (Node's EventEmitter does not treat `once` as "only the next listener in
  // line" -- every currently-attached listener fires on that emission), so
  // the second responder never sees the second request. Queueing avoids that.
  emitter._responders = [];
  stdin.on('data', (data: Buffer) => {
    for (const line of data.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const req = JSON.parse(line) as AcpRequest;
      emitter.received.push(req);
      const responder = emitter._responders.shift();
      if (responder) responder(req);
    }
  });
  return emitter;
}

function respondTo(child: FakeChild, result: unknown) {
  child._responders.push((req) => {
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
  });
}

function respondWithError(child: FakeChild, message: string) {
  child._responders.push((req) => {
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message } }) + '\n');
  });
}

function methodsSent(child: FakeChild): string[] {
  return child.received.map((r) => r.method);
}

describe('AcpClient.initialize', () => {
  // The bug this guards: initialize used to send `{}`. `protocolVersion` is a
  // REQUIRED field of InitializeRequest with no default, and the real adapter
  // answers `{}` with -32602 "Invalid params" and then exits -- which is what
  // made the adapter window flash open and shut with no connection.
  it('sends the required protocolVersion: 1', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);

    await client.initialize();

    expect(child.received).toHaveLength(1);
    expect(child.received[0].method).toBe('initialize');
    expect(child.received[0].params).toEqual({ protocolVersion: 1 });
  });

  it('returns the advertised authMethods', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);

    expect(await client.initialize()).toEqual(REAL_INITIALIZE_RESULT.authMethods);
  });

  // The real adapter answers a second `initialize` on the same connection with
  // -32603 {"details":"Already initialized"} (verified live), so this client
  // must never send one. main.ts composes ensureChatGptAuthenticated() with
  // probe() on a single client and would otherwise get a spurious 'error'.
  it('sends initialize only once per connection and reuses the result', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);

    const first = await client.initialize();
    const second = await client.initialize();

    expect(second).toEqual(first);
    expect(methodsSent(child)).toEqual(['initialize']);
  });

  it('retries the handshake when the first initialize failed', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondWithError(child, 'boom');
    await expect(client.initialize()).rejects.toThrow('boom');

    respondTo(child, REAL_INITIALIZE_RESULT);
    expect(await client.initialize()).toEqual(REAL_INITIALIZE_RESULT.authMethods);
    expect(methodsSent(child)).toEqual(['initialize', 'initialize']);
  });

  it('does not re-handshake when probe follows ensureChatGptAuthenticated on one client', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT); // initialize (ensure...)
    respondTo(child, { type: 'unauthenticated' }); // status (ensure...)
    respondWithError(child, 'login cancelled'); // authenticate
    respondTo(child, { type: 'unauthenticated' }); // status (probe)

    expect(await client.ensureChatGptAuthenticated()).toBe(false);
    // The precise reason must survive -- not collapse into 'error'.
    expect(await client.probe()).toBe('sign-in-required');
    expect(methodsSent(child).filter((m) => m === 'initialize')).toHaveLength(1);
  });

  it('returns an empty list when the response carries no authMethods', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, { protocolVersion: 1 });

    expect(await client.initialize()).toEqual([]);
  });
});

describe('AcpClient.probe', () => {
  it('returns ready-subscription when auth status is chat-gpt', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);
    respondTo(child, { type: 'chat-gpt', email: 'operator@example.com' });
    expect(await client.probe()).toBe('ready-subscription');
  });

  it('returns sign-in-required when unauthenticated', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);
    respondTo(child, { type: 'unauthenticated' });
    expect(await client.probe()).toBe('sign-in-required');
  });

  it('returns blocked-billing-mode for api-key status', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);
    respondTo(child, { type: 'api-key' });
    expect(await client.probe()).toBe('blocked-billing-mode');
  });

  it('returns blocked-billing-mode for gateway status', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);
    respondTo(child, { type: 'gateway', name: 'amazonBedrock' });
    expect(await client.probe()).toBe('blocked-billing-mode');
  });

  it('treats a malformed status reply as unknown, which blocks', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);
    respondTo(child, { type: 'something-new' });
    expect(await client.probe()).toBe('blocked-billing-mode');
  });

  it('returns blocked-billing-mode when chat-gpt is not an offered auth method', async () => {
    // What the real adapter returns when NO_BROWSER is set in the child env:
    // api-key only. Aether refuses rather than falling back to it.
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, { protocolVersion: 1, authMethods: [{ id: 'api-key', name: 'API Key' }] });

    expect(await client.probe()).toBe('blocked-billing-mode');
    expect(methodsSent(child)).toEqual(['initialize']); // no status call either
  });

  it('returns error status when initialize itself fails', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondWithError(child, 'boom');
    expect(await client.probe()).toBe('error');
  });

  // The core passive-vs-explicit boundary: a status check is something a
  // settings card or the Uplinks view does merely by mounting. `authenticate`
  // is the real login and can open a browser window, so it must never be
  // reachable from this path.
  it('NEVER sends the authenticate method', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);
    respondTo(child, { type: 'unauthenticated' });

    await client.probe();

    expect(methodsSent(child)).toEqual(['initialize', 'authentication/status']);
    expect(methodsSent(child)).not.toContain('authenticate');
  });
});

describe('AcpClient.ensureChatGptAuthenticated', () => {
  it('fails closed without ever sending authenticate when chat-gpt is not offered', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, { protocolVersion: 1, authMethods: [{ id: 'api-key', name: 'API Key' }] });

    expect(await client.ensureChatGptAuthenticated()).toBe(false);
    expect(methodsSent(child)).toEqual(['initialize']);
    expect(methodsSent(child)).not.toContain('authenticate');
  });

  it('fails closed without sending authenticate when authMethods is empty', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, { protocolVersion: 1 });

    expect(await client.ensureChatGptAuthenticated()).toBe(false);
    expect(methodsSent(child)).not.toContain('authenticate');
  });

  it('skips authenticate entirely when already signed in with chat-gpt', async () => {
    // No browser window for an operator who is already logged in.
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);
    respondTo(child, { type: 'chat-gpt', email: 'operator@example.com' });

    expect(await client.ensureChatGptAuthenticated()).toBe(true);
    expect(methodsSent(child)).toEqual(['initialize', 'authentication/status']);
  });

  it('sends authenticate with methodId chat-gpt and re-reads real status afterwards', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);
    respondTo(child, { type: 'unauthenticated' }); // before login
    respondTo(child, {}); // AuthenticateResponse is essentially empty
    respondTo(child, { type: 'chat-gpt', email: 'operator@example.com' }); // after login

    expect(await client.ensureChatGptAuthenticated()).toBe(true);
    expect(methodsSent(child)).toEqual(['initialize', 'authentication/status', 'authenticate', 'authentication/status']);
    const authRequest = child.received.find((r) => r.method === 'authenticate');
    expect(authRequest?.params).toEqual({ methodId: 'chat-gpt' });
  });

  it('returns false when authenticate itself is rejected by the agent', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);
    respondTo(child, { type: 'unauthenticated' });
    respondWithError(child, 'login aborted');

    expect(await client.ensureChatGptAuthenticated()).toBe(false);
  });

  it('returns false when authenticate resolves but the account is an api-key login', async () => {
    // Never trust the empty AuthenticateResponse as proof of subscription auth.
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);
    respondTo(child, { type: 'unauthenticated' });
    respondTo(child, {});
    respondTo(child, { type: 'api-key' });

    expect(await client.ensureChatGptAuthenticated()).toBe(false);
  });
});
