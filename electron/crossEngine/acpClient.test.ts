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

type FakeChild = {
  stdout: PassThrough;
  stdin: PassThrough;
  kill: () => void;
  _responders: Array<(req: { id: number }) => void>;
};

function fakeChild(): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const emitter = new EventEmitter() as unknown as FakeChild;
  emitter.stdout = stdout;
  emitter.stdin = stdin;
  emitter.kill = vi.fn();
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
      const req = JSON.parse(line) as { id: number };
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

describe('AcpClient.probe', () => {
  it('returns ready-subscription when auth status is chat-gpt', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, {}); // initialize
    respondTo(child, { type: 'chat-gpt' }); // authentication/status
    expect(await client.probe()).toBe('ready-subscription');
  });

  it('returns sign-in-required when unauthenticated', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, {});
    respondTo(child, { type: 'unauthenticated' });
    expect(await client.probe()).toBe('sign-in-required');
  });

  it('returns blocked-billing-mode for api-key status', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, {});
    respondTo(child, { type: 'api-key' });
    expect(await client.probe()).toBe('blocked-billing-mode');
  });

  it('returns blocked-billing-mode for gateway status', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, {});
    respondTo(child, { type: 'gateway' });
    expect(await client.probe()).toBe('blocked-billing-mode');
  });

  it('treats a malformed status reply as unknown, which blocks', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, {});
    child._responders.push((req) => {
      child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { type: 'something-new' } }) + '\n');
    });
    expect(await client.probe()).toBe('blocked-billing-mode');
  });

  it('returns error status when initialize itself fails', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    child._responders.push((req) => {
      child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -1, message: 'boom' } }) + '\n');
    });
    expect(await client.probe()).toBe('error');
  });
});
