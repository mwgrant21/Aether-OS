import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync, spawn } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import http from 'node:http';

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
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ behavior: 'allow', updatedInput: { command: 'ls -la' } })
        );
      });
    });
    activeServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const home = setupHome('sess-own', String(port));
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
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ block: true, reason: 'anomaly detected: unexpected file write' })
        );
      });
    });
    activeServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const home = setupHome('sess-own', String(port));
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
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ block: false }));
      });
    });
    activeServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const home = setupHome('sess-own', String(port));
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
