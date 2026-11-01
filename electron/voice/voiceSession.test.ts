// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createVoiceSession, VOICE_PROMPT, type SessionEvent, type VoiceSession } from './voiceSession';

const FAKE = path.join(__dirname, '__fixtures__', 'fakeClaude.mjs');

interface Harness {
  session: VoiceSession;
  events: SessionEvent[];
  spawned: { args: string[]; opts: SpawnOptions; child: ChildProcess; stderr: string }[];
  logs: string[];
}

const live: VoiceSession[] = [];

function harness(extraEnv: Record<string, string> = {}, over: Parameters<typeof createVoiceSession>[0] = {}): Harness {
  const spawned: Harness['spawned'] = [];
  const logs: string[] = [];
  const session = createVoiceSession({
    backoffMs: [0, 10, 10, 10, 10],
    killGraceMs: 300,
    interruptTimeoutMs: 150,
    log: (l) => logs.push(l),
    spawnFn: (args, opts) => {
      const child = spawn(process.execPath, [FAKE], { ...opts, env: { ...opts.env, ...extraEnv } });
      const rec = { args, opts, child, stderr: '' };
      child.stderr?.on('data', (d: Buffer) => { rec.stderr += d.toString(); });
      spawned.push(rec);
      return child;
    },
    ...over,
  });
  live.push(session);
  const events: SessionEvent[] = [];
  session.on((e) => events.push(e));
  return { session, events, spawned, logs };
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const ready = (h: Harness) => h.session.state() === 'ready';
const resultFor = (h: Harness, id: string) => h.events.find((e) => e.k === 'result' && e.turnId === id);
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

afterEach(async () => {
  while (live.length) await live.pop()!.stop();
});

describe('voiceSession spawn contract', () => {
  it('uses the exact argument set, no bypass, hooks off', async () => {
    const h = harness();
    h.session.start();
    await waitFor(() => ready(h));
    const a = h.spawned[0].args;
    const pair = (k: string, v: string) => expect(a[a.indexOf(k) + 1]).toBe(v);
    pair('--model', 'sonnet');
    pair('--effort', 'medium');
    pair('--settings', '{"disableAllHooks":true}');
    pair('--permission-mode', 'manual');
    pair('--permission-prompt-tool', 'stdio');
    pair('--input-format', 'stream-json');
    pair('--output-format', 'stream-json');
    pair('--append-system-prompt', VOICE_PROMPT);
    for (const f of ['-p', '--verbose', '--include-partial-messages', '--strict-mcp-config', '--no-session-persistence']) {
      expect(a).toContain(f);
    }
    expect(a.join(' ')).not.toMatch(/dangerously-skip-permissions|bypassPermissions/);
    expect(h.spawned[0].opts.shell).toBe(false);
    expect(h.spawned[0].opts.windowsHide).toBe(true);
  });

  it('child env has no ANTHROPIC_* (any case) and sets AETHER_STATUSLINE_NO_PERSIST', async () => {
    process.env.Anthropic_Api_Key = 'sk-ant-test-not-real';
    try {
      const h = harness();
      h.session.start();
      await waitFor(() => ready(h));
      const env = h.spawned[0].opts.env as NodeJS.ProcessEnv;
      expect(Object.keys(env).filter((k) => /^anthropic_/i.test(k))).toEqual([]);
      expect(env.AETHER_STATUSLINE_NO_PERSIST).toBe('1');
    } finally {
      delete process.env.Anthropic_Api_Key;
    }
  });

  it('VOICE_PROMPT is one ASCII line without a double quote', () => {
    expect(VOICE_PROMPT).not.toMatch(/["\n\r]/);
    expect(VOICE_PROMPT).toMatch(/^[\x20-\x7e]+$/);
  });

  it('source keeps the literal claude launch with shell:false and windowsHide:true', () => {
    const src = fs.readFileSync(path.join(__dirname, 'voiceSession.ts'), 'utf8');
    expect(src).toContain("spawn('claude'");
    expect(src).toContain('shell: false');
    expect(src).toContain('windowsHide: true');
  });
});

describe('voiceSession protocol', () => {
  it('swallows the prime turn, reaches ready, refuses send before ready', async () => {
    const h = harness();
    expect(h.session.send('t0000001', 'hi')).toBe(false);
    h.session.start();
    expect(h.session.send('t0000001', 'hi')).toBe(false);
    await waitFor(() => ready(h));
    expect(h.events.filter((e) => e.k === 'delta' || e.k === 'result')).toEqual([]);
    expect(h.events.map((e) => e.k === 'state' && e.state)).toEqual(['starting', 'ready']);
  });

  it('maps delta, tool and result events', async () => {
    const h = harness();
    h.session.start();
    await waitFor(() => ready(h));
    expect(h.session.send('turn0001', 'hello')).toBe(true);
    await waitFor(() => !!resultFor(h, 'turn0001'));
    const text = h.events.filter((e) => e.k === 'delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('ok: hello');
    expect(resultFor(h, 'turn0001')).toEqual({ k: 'result', turnId: 'turn0001', ok: true, interrupted: false });
    h.session.send('turn0002', '[[tool]]');
    await waitFor(() => !!resultFor(h, 'turn0002'));
    expect(h.events).toContainEqual({ k: 'tool', turnId: 'turn0002', name: 'Bash', agent: false });
  });

  it('decodes a multi-byte character split across stdout chunks', async () => {
    const h = harness();
    h.session.start();
    await waitFor(() => ready(h));
    h.session.send('turn0001', '[[utf8]]');
    await waitFor(() => !!resultFor(h, 'turn0001'));
    const text = h.events.filter((e) => e.k === 'delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('café ☃ ok');
  });

  it('the fake [[secret]] turn emits a real maskable key and password split across chunks', async () => {
    const h = harness();
    h.session.start();
    await waitFor(() => ready(h));
    h.session.send('turn0001', '[[secret]]');
    await waitFor(() => !!resultFor(h, 'turn0001'));
    const deltas = h.events.filter((e) => e.k === 'delta').map((e) => (e as { text: string }).text);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    const text = deltas.join('');
    expect(text).toMatch(/sk-ant-[A-Za-z0-9]{30,}/);
    expect(text).toContain('password=hunter2hunter2');
  });

  it('emits permission events and answers them over stdin', async () => {
    const h = harness();
    h.session.start();
    await waitFor(() => ready(h));
    h.session.send('turn0001', '[[perm]]');
    await waitFor(() => h.events.some((e) => e.k === 'permission'));
    const p = h.events.find((e) => e.k === 'permission') as Extract<SessionEvent, { k: 'permission' }>;
    expect(p.tool).toBe('Bash');
    h.session.answerPermission(p.id, false);
    await waitFor(() => !!resultFor(h, 'turn0001'));
    const text = h.events.filter((e) => e.k === 'delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('perm: deny');
  });

  it('interrupt mid-turn gives result{interrupted} and the same pid answers the next turn', async () => {
    const h = harness();
    h.session.start();
    await waitFor(() => ready(h));
    const pid = h.session.pid();
    h.session.send('turn0001', '[[slow]]');
    await waitFor(() => h.events.some((e) => e.k === 'delta'));
    h.session.interrupt();
    await waitFor(() => !!resultFor(h, 'turn0001'));
    expect(resultFor(h, 'turn0001')).toMatchObject({ interrupted: true });
    expect(h.session.send('turn0002', 'again')).toBe(true);
    await waitFor(() => !!resultFor(h, 'turn0002'));
    expect(h.session.pid()).toBe(pid);
    expect(h.spawned).toHaveLength(1);
  });

  it('a child that ignores interrupt is restarted after the timeout', async () => {
    const h = harness();
    h.session.start();
    await waitFor(() => ready(h));
    const pid = h.session.pid();
    h.session.send('turn0001', '[[hang]]');
    await waitFor(() => h.events.some((e) => e.k === 'delta'));
    h.session.interrupt();
    await waitFor(() => !!resultFor(h, 'turn0001'));
    expect(resultFor(h, 'turn0001')).toMatchObject({ interrupted: true, ok: false });
    await waitFor(() => ready(h) && h.session.pid() !== pid);
    expect(h.spawned).toHaveLength(2);
    await waitFor(() => !pidAlive(pid!));
  });
});

describe('voiceSession supervision', () => {
  it('crash mid-turn emits lost, then returns to ready on a new pid', async () => {
    const h = harness();
    h.session.start();
    await waitFor(() => ready(h));
    const pid = h.session.pid();
    h.session.send('turn0001', '[[crash]]');
    await waitFor(() => h.events.some((e) => e.k === 'lost'));
    expect(h.events).toContainEqual({ k: 'lost', turnId: 'turn0001' });
    expect(h.events).toContainEqual({ k: 'state', state: 'restarting' });
    await waitFor(() => ready(h) && h.session.pid() !== pid);
    expect(h.session.pid()).not.toBeNull();
  });

  it('repeated immediate exits end in state down (5 exits in 60 s) and no more spawns', async () => {
    const h = harness({ FAKE_CLAUDE_EXIT_AFTER_MS: '0' }, { backoffMs: [0, 0, 0, 0, 0] });
    h.session.start();
    await waitFor(() => h.session.state() === 'down');
    expect(h.spawned).toHaveLength(5);
    expect(h.logs).toContain('voice: session down');
    await new Promise((r) => setTimeout(r, 100));
    expect(h.spawned).toHaveLength(5);
  });

  it('stop() ends the child via stdin EOF without a kill when it exits in time', async () => {
    const h = harness();
    h.session.start();
    await waitFor(() => ready(h));
    const child = h.spawned[0].child;
    await h.session.stop();
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
    expect(h.spawned).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'win32')('stop() leaves no child or grandchild process on win32', async () => {
    const h = harness({ FAKE_CLAUDE_GRANDCHILD: '1' });
    h.session.start();
    await waitFor(() => ready(h));
    await waitFor(() => /gc=\d+/.test(h.spawned[0].stderr));
    const childPid = h.session.pid()!;
    const gcPid = Number(/gc=(\d+)/.exec(h.spawned[0].stderr)![1]);
    expect(pidAlive(childPid)).toBe(true);
    expect(pidAlive(gcPid)).toBe(true);
    await h.session.stop();
    await waitFor(() => !pidAlive(childPid) && !pidAlive(gcPid), 3000);
    expect(pidAlive(childPid)).toBe(false);
    expect(pidAlive(gcPid)).toBe(false);
  });

  it('logs fixed strings only, never reply text', async () => {
    const h = harness();
    h.session.start();
    await waitFor(() => ready(h));
    h.session.send('turn0001', 'my secret reply text');
    await waitFor(() => !!resultFor(h, 'turn0001'));
    await h.session.stop();
    expect(h.logs.length).toBeGreaterThan(0);
    for (const l of h.logs) {
      expect(l).toMatch(/^voice: session (starting|ready|down|exited code=-?\w+)$/);
      expect(l).not.toContain('secret');
    }
  });
});
