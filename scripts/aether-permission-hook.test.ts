import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync, spawn } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import http from 'node:http';
import { createHmac } from 'node:crypto';

const scriptPath = fileURLToPath(new URL('./aether-permission-hook.mjs', import.meta.url));

function setupHome(sessionId: string | null, portFileContents: string | null) {
  const home = mkdtempSync(join(tmpdir(), 'aether-permission-hook-'));
  const aetherDir = join(home, '.aether-os');
  mkdirSync(aetherDir, { recursive: true });
  if (sessionId !== null) {
    writeFileSync(join(aetherDir, 'own-session.json'), JSON.stringify({ sessionId }), 'utf8');
  }
  if (portFileContents !== null) {
    writeFileSync(join(aetherDir, 'permission-server-port'), portFileContents, 'utf8');
  }
  return home;
}

function runScript(stdin: string, homeDir: string) {
  return spawnSync('node', [scriptPath], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    timeout: 10000,
  });
}

// spawnSync blocks this process's event loop for the duration of the child
// process -- fine when the child talks to nothing, but fatal when the child
// needs to reach an in-process fixture http.createServer, since that server
// can only accept/service the connection while THIS process's event loop is
// free to run. Use async spawn + a Promise for any case that involves a
// same-process fixture server.
function runScriptAsync(stdin: string, homeDir: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [scriptPath], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

// Security audit 2026-10-04: the hook must authenticate the server it talks
// to. Computed here with node:crypto directly, independent of the hook's own
// implementation, so a shared bug cannot make both sides agree.
const SECRET = 'ab'.repeat(32);
const sign = (secret: string, role: 'client' | 'server', nonce: string, path: string) =>
  createHmac('sha256', secret).update(`${role}\n${nonce}\n${path}`).digest('hex');
const portFile = (port: number, secret = SECRET) => JSON.stringify({ port, secret });

type Proof = 'valid' | 'none' | 'wrong';
// A fixture server answering `response`. 'valid' plays the real Aether server
// (signs its proof with SECRET); 'none'/'wrong' play a port squatter.
async function startFixture(response: unknown, proof: Proof, seen: { clientAuthOk?: boolean } = {}): Promise<number> {
  const server = http.createServer((req, res) => {
    const nonce = String(req.headers['x-aether-nonce'] ?? '');
    seen.clientAuthOk = req.headers['x-aether-auth'] === sign(SECRET, 'client', nonce, req.url ?? '');
    req.on('data', () => {});
    req.on('end', () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (proof === 'valid') headers['X-Aether-Proof'] = sign(SECRET, 'server', nonce, req.url ?? '');
      if (proof === 'wrong') headers['X-Aether-Proof'] = sign('cd'.repeat(32), 'server', nonce, req.url ?? '');
      res.writeHead(200, headers).end(JSON.stringify(response));
    });
  });
  activeServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

let activeServers: http.Server[] = [];
afterEach(() => {
  for (const server of activeServers) server.close();
  activeServers = [];
});

describe('aether-permission-hook.mjs', () => {
  it('falls through non-blocking (exit 0, no stdout) on session_id mismatch', () => {
    const home = setupHome('sess-own', '65535');
    const payload = JSON.stringify({
      session_id: 'sess-other',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'tu-1',
    });
    const result = runScript(payload, home);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('falls through non-blocking when nothing is listening on the discovered port', () => {
    const home = setupHome('sess-own', '1'); // port 1 -- nothing listening, should fail fast
    const payload = JSON.stringify({
      session_id: 'sess-own',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'tu-1',
    });
    const start = Date.now();
    const result = runScript(payload, home);
    const elapsedMs = Date.now() - start;
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('round-trips a real decision from a fixture server into the exact hookSpecificOutput JSON shape', async () => {
    const port = await startFixture({ behavior: 'allow', updatedInput: { command: 'ls -la' } }, 'valid');

    const home = setupHome('sess-own', portFile(port));
    const payload = JSON.stringify({
      session_id: 'sess-own',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'tu-1',
    });
    const result = await runScriptAsync(payload, home);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { command: 'ls -la' } },
      },
    });
  });

  it('falls through non-blocking when no own-session.json exists', () => {
    const home = setupHome(null, '65535');
    const payload = JSON.stringify({
      session_id: 'sess-own',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'tu-1',
    });
    const result = runScript(payload, home);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('falls through non-blocking on empty stdin', () => {
    const home = setupHome('sess-own', '65535');
    const result = runScript('', home);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});

describe('aether-permission-hook.mjs -- server authentication', () => {
  const permissionPayload = JSON.stringify({
    session_id: 'sess-own',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: 'tu-1',
  });
  const allowWithSwap = { behavior: 'allow', updatedInput: { command: 'echo dummy' } };

  it('falls through when a port squatter answers allow without a server proof', async () => {
    const port = await startFixture(allowWithSwap, 'none');
    const result = await runScriptAsync(permissionPayload, setupHome('sess-own', portFile(port)));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('falls through when the server proof was signed with a different secret', async () => {
    const port = await startFixture(allowWithSwap, 'wrong');
    const result = await runScriptAsync(permissionPayload, setupHome('sess-own', portFile(port)));
    expect(result.stdout.trim()).toBe('');
  });

  it('falls through on a legacy bare-number port file, which carries no secret', async () => {
    const port = await startFixture(allowWithSwap, 'valid');
    const result = await runScriptAsync(permissionPayload, setupHome('sess-own', String(port)));
    expect(result.stdout.trim()).toBe('');
  });

  it('falls through on a PostToolUse block from an unproven server', async () => {
    const port = await startFixture({ block: true, reason: 'squatter' }, 'none');
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'sess-own',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_output: { output: 'ok' },
      tool_use_id: 'tu-1',
    });
    const result = await runScriptAsync(payload, setupHome('sess-own', portFile(port)));
    expect(result.stdout.trim()).toBe('');
  });

  it('signs its own request with the client HMAC for the route it calls', async () => {
    const seen: { clientAuthOk?: boolean } = {};
    const port = await startFixture({ behavior: 'deny' }, 'valid', seen);
    await runScriptAsync(permissionPayload, setupHome('sess-own', portFile(port)));
    expect(seen.clientAuthOk).toBe(true);
  });
});

describe('aether-permission-hook.mjs -- PostToolUse branch', () => {
  it('falls through non-blocking when nothing is listening on the discovered port', () => {
    const home = setupHome('sess-own', '1'); // port 1 -- nothing listening
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'sess-own',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_output: { output: 'ok' },
      tool_use_id: 'tu-1',
    });
    const start = Date.now();
    const result = runScript(payload, home);
    const elapsedMs = Date.now() - start;
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('translates a block decision from a fixture server into the real PostToolUse stdout contract', async () => {
    const port = await startFixture({ block: true, reason: 'anomaly detected: unexpected file write' }, 'valid');

    const home = setupHome('sess-own', portFile(port));
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'sess-own',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_output: { output: 'ok' },
      tool_use_id: 'tu-1',
    });
    const result = await runScriptAsync(payload, home);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    // Real PostToolUse contract: bare string "decision": "block", NOT the
    // nested hookSpecificOutput.decision.behavior object shape PermissionRequest uses.
    expect(parsed).toEqual({
      decision: 'block',
      reason: 'anomaly detected: unexpected file write',
    });
  });

  it('produces no stdout when the flag-check decision is clean (block: false)', async () => {
    const port = await startFixture({ block: false }, 'valid');

    const home = setupHome('sess-own', portFile(port));
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'sess-own',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_output: { output: 'ok' },
      tool_use_id: 'tu-1',
    });
    const result = await runScriptAsync(payload, home);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('falls through non-blocking on session_id mismatch for PostToolUse', () => {
    const home = setupHome('sess-own', '65535');
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'sess-other',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_output: { output: 'ok' },
      tool_use_id: 'tu-1',
    });
    const result = runScript(payload, home);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});
