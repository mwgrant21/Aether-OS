import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { startPermissionServer } from './permissionServer';

function postJson(port: number, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('permissionServer', () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    if (stop) stop();
    stop = null;
  });

  it('resolves POST /permission-request with the decision returned by onPermissionRequest', async () => {
    const started = await startPermissionServer({
      port: 0,
      timeoutMs: 5000,
      onPermissionRequest: async () => ({ behavior: 'allow' as const }),
    });
    stop = started.stop;
    expect(started.port).toBeGreaterThan(0);
    const res = await postJson(started.port, '/permission-request', { toolName: 'Read', toolInput: { file_path: 'x' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ behavior: 'allow' });
  });

  it('propagates a deny decision with a reason', async () => {
    const started = await startPermissionServer({
      port: 0,
      timeoutMs: 5000,
      onPermissionRequest: async () => ({ behavior: 'deny' as const, reason: 'nope' }),
    });
    stop = started.stop;
    const res = await postJson(started.port, '/permission-request', { toolName: 'Bash', toolInput: { command: 'rm -rf /' } });
    expect(res.body).toEqual({ behavior: 'deny', reason: 'nope' });
  });

  it('propagates updatedInput when the decision includes it', async () => {
    const started = await startPermissionServer({
      port: 0,
      timeoutMs: 5000,
      onPermissionRequest: async () => ({ behavior: 'allow' as const, updatedInput: { file_path: 'src/**' } }),
    });
    stop = started.stop;
    const res = await postJson(started.port, '/permission-request', { toolName: 'Write', toolInput: { file_path: 'src/x.ts' } });
    expect(res.body.updatedInput).toEqual({ file_path: 'src/**' });
  });

  it('auto-denies with a timeout reason when onPermissionRequest never resolves within timeoutMs', async () => {
    const started = await startPermissionServer({
      port: 0,
      timeoutMs: 50,
      onPermissionRequest: () => new Promise(() => {}), // never resolves
    });
    stop = started.stop;
    const res = await postJson(started.port, '/permission-request', { toolName: 'Read', toolInput: {} });
    expect(res.body.behavior).toBe('deny');
    expect(res.body.reason).toMatch(/timeout/i);
  });

  it('auto-denies (instead of hanging) when onPermissionRequest throws synchronously', async () => {
    const started = await startPermissionServer({
      port: 0,
      timeoutMs: 50,
      onPermissionRequest: () => {
        throw new Error('boom');
      },
    });
    stop = started.stop;
    const res = await postJson(started.port, '/permission-request', { toolName: 'Read', toolInput: {} });
    expect(res.status).toBe(200);
    expect(res.body.behavior).toBe('deny');
  });

  it('auto-denies (instead of crashing the process) when onPermissionRequest returns a rejected promise', async () => {
    const started = await startPermissionServer({
      port: 0,
      timeoutMs: 50,
      onPermissionRequest: async () => {
        throw new Error('rejected');
      },
    });
    stop = started.stop;
    const res = await postJson(started.port, '/permission-request', { toolName: 'Read', toolInput: {} });
    expect(res.status).toBe(200);
    expect(res.body.behavior).toBe('deny');
  });

  it('returns 400 on malformed request body', async () => {
    const started = await startPermissionServer({ port: 0, timeoutMs: 5000, onPermissionRequest: async () => ({ behavior: 'allow' as const }) });
    stop = started.stop;
    const res = await postJson(started.port, '/permission-request', { notToolName: true });
    expect(res.status).toBe(400);
  });

  it('a request to an unknown path returns 404', async () => {
    const started = await startPermissionServer({ port: 0, timeoutMs: 5000, onPermissionRequest: async () => ({ behavior: 'allow' as const }) });
    stop = started.stop;
    const res = await postJson(started.port, '/nonexistent', {});
    expect(res.status).toBe(404);
  });

  it('POST /post-tool-flag-check calls onPostToolUse and returns its decision when a detector trips', async () => {
    const started = await startPermissionServer({
      port: 0,
      timeoutMs: 5000,
      onPermissionRequest: async () => ({ behavior: 'allow' as const }),
      onPostToolUse: async () => ({ block: true, reason: 'reReadLoop: src/foo.ts read 3 times' }),
      postToolUseTimeoutMs: 5000,
    });
    stop = started.stop;
    const res = await postJson(started.port, '/post-tool-flag-check', { toolUseId: 'tu_1', toolName: 'Read', toolOutput: 'x' });
    expect(res.body).toEqual({ block: true, reason: 'reReadLoop: src/foo.ts read 3 times' });
  });

  it('auto-allows (not deny) on /post-tool-flag-check timeout', async () => {
    const started = await startPermissionServer({
      port: 0,
      timeoutMs: 5000,
      onPermissionRequest: async () => ({ behavior: 'allow' as const }),
      onPostToolUse: () => new Promise(() => {}),
      postToolUseTimeoutMs: 50,
    });
    stop = started.stop;
    const res = await postJson(started.port, '/post-tool-flag-check', { toolUseId: 'tu_1', toolName: 'Read', toolOutput: 'x' });
    expect(res.body.block).toBe(false);
    expect(res.body.reason).toMatch(/timeout/i);
  });

  it('rejects (instead of crashing the process) when the port is already bound', async () => {
    const holder = await startPermissionServer({
      port: 0,
      timeoutMs: 5000,
      onPermissionRequest: async () => ({ behavior: 'allow' as const }),
    });
    stop = holder.stop;
    await expect(
      startPermissionServer({
        port: holder.port,
        timeoutMs: 5000,
        onPermissionRequest: async () => ({ behavior: 'allow' as const }),
      })
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});
