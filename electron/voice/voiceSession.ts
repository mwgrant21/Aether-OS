// Supervisor for the ONE long-lived, hook-free `claude -p` stream-json child
// behind the voice gateway (privacy §18). This is the only file under
// electron/voice/ that may import node:child_process.
//
// Permissions (voice M1 spec Q4, probed live against CLI 2.1.316 on 2026-10-31):
// `--permission-prompt-tool stdio` WORKS. With `--permission-mode manual` and a
// Write outside the cwd the child emitted, on stdout,
//   {"type":"control_request","request_id":"<uuid>","request":{"subtype":"can_use_tool",
//    "tool_name":"Write","display_name":"Write","input":{...},"description":"...",
//    "permission_suggestions":[...],"decision_reason":"...","tool_use_id":"..."}}
// and a reply line
//   {"type":"control_response","response":{"subtype":"success","request_id":"<same>",
//    "response":{"behavior":"allow"|"deny","message":"..."}}}
// resolved it (deny surfaced as an is_error tool_result with our message). Without
// `--permission-mode manual` the operator's own settings auto-allowed Write and Bash
// and no request was ever emitted, so manual is pinned here: voice never inherits a
// looser mode. For comparison `--permission-prompts none` auto-denied the same Write.
// Allow replies carry no updatedInput, so the tool runs with its original input.
import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';
import { buildAllowlistedChildEnv, attachStderrRingBuffer } from '../crossEngine/acpProcess';

export type SessionState = 'starting' | 'ready' | 'restarting' | 'down';

export type SessionEvent =
  | { k: 'state'; state: SessionState }
  | { k: 'delta'; turnId: string; text: string }
  | { k: 'tool'; turnId: string; name: string; agent: boolean }
  | { k: 'permission'; id: string; tool: string; input: unknown }
  | { k: 'result'; turnId: string; ok: boolean; interrupted: boolean }
  | { k: 'lost'; turnId: string };

export interface SessionDeps {
  spawnFn?: (args: string[], opts: SpawnOptions) => ChildProcess;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (t: unknown) => void;
  log?: (line: string) => void;
  model?: 'sonnet' | 'haiku' | 'opus';
  backoffMs?: number[];
  killGraceMs?: number;
  interruptTimeoutMs?: number;
  cwd?: string;
}

export interface VoiceSession {
  start(): void;
  send(turnId: string, text: string): boolean;
  interrupt(): void;
  answerPermission(id: string, allow: boolean): void;
  stop(): Promise<void>;
  on(cb: (e: SessionEvent) => void): () => void;
  state(): SessionState | 'none';
  pid(): number | null;
}

/** One ASCII line: no double quote, no newline (it travels as a single argv entry). */
export const VOICE_PROMPT =
  "You are a voice assistant. Your replies are spoken aloud. Use contractions and short spoken sentences. " +
  "No markdown, no lists, no headings. Do not restate the question. Say numbers in words. " +
  "Never read out keys, tokens or passwords. " +
  "If asked for detail, give one spoken line, then a line containing only ---, then the detail.";

const PRIME_TURN = 'prime';
const PRIME_TEXT = 'Reply with exactly one word: ready';
const MAX_LINE = 1024 * 1024;
const DEFAULT_BACKOFF = [0, 1000, 2000, 4000, 8000];
const MAX_FAILED_STARTS = 5;
const EXIT_WINDOW_MS = 60_000;
const MAX_EXITS_IN_WINDOW = 5;

function buildArgs(model: string): string[] {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', model,
    '--effort', 'medium',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--permission-mode', 'manual',
    '--permission-prompt-tool', 'stdio',
    '--append-system-prompt', VOICE_PROMPT,
    '--settings', '{"disableAllHooks":true}',
  ];
}

export function createVoiceSession(deps: SessionDeps = {}): VoiceSession {
  const now = deps.now ?? Date.now;
  const setT = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeoutFn ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const log = deps.log ?? (() => undefined);
  const backoff = deps.backoffMs ?? DEFAULT_BACKOFF;
  const killGraceMs = deps.killGraceMs ?? 2000;
  const interruptTimeoutMs = deps.interruptTimeoutMs ?? 3000;
  const args = buildArgs(deps.model ?? 'sonnet');
  const listeners = new Set<(e: SessionEvent) => void>();

  const defaultSpawn = (a: string[], o: SpawnOptions): ChildProcess => spawn('claude', a, o);
  const spawnFn = deps.spawnFn ?? defaultSpawn;

  let state: SessionState | 'none' = 'none';
  let child: ChildProcess | null = null;
  let stopping = false;
  let started = false;
  let inflight: { turnId: string; interrupted: boolean } | null = null;
  let interruptTimer: unknown = null;
  let restartTimer: unknown = null;
  let failedStarts = 0;
  let reachedReady = false;
  const exitTimes: number[] = [];

  function emit(e: SessionEvent): void {
    for (const cb of [...listeners]) {
      try { cb(e); } catch { /* a listener must not break the supervisor */ }
    }
  }
  function setState(s: SessionState): void {
    if (state === s) return;
    state = s;
    emit({ k: 'state', state: s });
  }
  function writeLine(obj: unknown): boolean {
    const c = child;
    if (!c || !c.stdin || c.stdin.destroyed || !c.stdin.writable) return false;
    try { c.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
  }
  function clearInterruptTimer(): void {
    if (interruptTimer !== null) { clearT(interruptTimer); interruptTimer = null; }
  }

  function handleLine(line: string, mine: ChildProcess): void {
    if (mine !== child) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (msg === null || typeof msg !== 'object') return;
    const type = msg.type;
    if (type === 'stream_event') {
      const ev = msg.event as { type?: string; delta?: { type?: string; text?: unknown }; content_block?: { type?: string; name?: unknown } } | undefined;
      if (!ev || !inflight) return;
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
        if (inflight.turnId !== PRIME_TURN) emit({ k: 'delta', turnId: inflight.turnId, text: ev.delta.text });
      } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        const name = typeof ev.content_block.name === 'string' ? ev.content_block.name : 'tool';
        if (inflight.turnId !== PRIME_TURN) {
          emit({ k: 'tool', turnId: inflight.turnId, name, agent: name === 'Task' || name === 'Agent' });
        }
      }
      return;
    }
    if (type === 'control_request') {
      const req = msg.request as { subtype?: string; tool_name?: unknown; input?: unknown } | undefined;
      if (req?.subtype === 'can_use_tool' && typeof msg.request_id === 'string') {
        emit({
          k: 'permission',
          id: msg.request_id,
          tool: typeof req.tool_name === 'string' ? req.tool_name : 'tool',
          input: req.input,
        });
      }
      return;
    }
    if (type === 'result') {
      const cur = inflight;
      if (!cur) return;
      clearInterruptTimer();
      inflight = null;
      if (cur.turnId === PRIME_TURN) {
        reachedReady = true;
        failedStarts = 0;
        log('voice: session ready');
        setState('ready');
        return;
      }
      const ok = msg.subtype === 'success' && msg.is_error !== true;
      emit({ k: 'result', turnId: cur.turnId, ok, interrupted: cur.interrupted });
    }
  }

  function attach(c: ChildProcess): void {
    attachStderrRingBuffer(c as unknown as Parameters<typeof attachStderrRingBuffer>[0]);
    const dec = new StringDecoder('utf8');
    let pending = '';
    let dropping = false;
    c.stdout?.on('data', (chunk: Buffer) => {
      pending += dec.write(chunk);
      let i: number;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        if (dropping) { dropping = false; continue; }
        if (line.length <= MAX_LINE && line.trim()) handleLine(line, c);
      }
      if (pending.length > MAX_LINE) { pending = ''; dropping = true; }
    });
    c.stdin?.on('error', () => undefined);
    let handled = false;
    const onGone = (code: number | null): void => {
      if (handled) return;
      handled = true;
      handleExit(c, code);
    };
    c.on('exit', onGone);
    c.on('error', () => onGone(null));
  }

  function spawnChild(): void {
    if (stopping) return;
    reachedReady = false;
    inflight = null;
    setState('starting');
    log('voice: session starting');
    const env: NodeJS.ProcessEnv = { ...buildAllowlistedChildEnv(process.env), AETHER_STATUSLINE_NO_PERSIST: '1' };
    let c: ChildProcess;
    try {
      c = spawnFn(args, { cwd: deps.cwd ?? os.tmpdir(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch {
      child = null;
      scheduleRestart();
      return;
    }
    child = c;
    attach(c);
    inflight = { turnId: PRIME_TURN, interrupted: false };
    writeLine({ type: 'user', message: { role: 'user', content: PRIME_TEXT } });
  }

  function handleExit(c: ChildProcess, code: number | null): void {
    if (c !== child) return; // replaced or already torn down on purpose
    child = null;
    log('voice: session exited code=' + String(code));
    if (stopping) return;
    clearInterruptTimer();
    if (inflight && inflight.turnId !== PRIME_TURN) emit({ k: 'lost', turnId: inflight.turnId });
    inflight = null;
    scheduleRestart();
  }

  function scheduleRestart(): void {
    const t = now();
    exitTimes.push(t);
    while (exitTimes.length > 0 && t - exitTimes[0] > EXIT_WINDOW_MS) exitTimes.shift();
    if (!reachedReady) failedStarts += 1;
    if (failedStarts > MAX_FAILED_STARTS || exitTimes.length >= MAX_EXITS_IN_WINDOW) {
      log('voice: session down');
      setState('down');
      return;
    }
    setState('restarting');
    const delay = backoff[Math.min(Math.max(failedStarts - 1, 0), backoff.length - 1)] ?? 0;
    restartTimer = setT(() => { restartTimer = null; spawnChild(); }, delay);
  }

  function killTree(c: ChildProcess): void {
    const pid = c.pid;
    const plain = (): void => { try { c.kill(); } catch { /* already gone */ } };
    if (process.platform === 'win32' && pid) {
      // child.kill() on Windows ends only the child, so taskkill /T runs FIRST while the
      // parent link still exists; kill() is the fallback. Fixed argv, our own pid only.
      try {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, plain);
        return;
      } catch { /* fall through to kill */ }
    }
    plain();
  }

  function interruptFallback(): void {
    interruptTimer = null;
    const cur = inflight;
    const dead = child;
    if (!dead || !cur) return;
    child = null; // detach so its exit is not treated as a crash
    inflight = null;
    emit({ k: 'result', turnId: cur.turnId, ok: false, interrupted: true });
    killTree(dead);
    setState('restarting');
    spawnChild();
  }

  return {
    start() {
      if (started) return;
      started = true;
      spawnChild();
    },
    send(turnId, text) {
      if (state !== 'ready' || inflight || !child) return false;
      inflight = { turnId, interrupted: false };
      if (!writeLine({ type: 'user', message: { role: 'user', content: text } })) {
        inflight = null;
        return false;
      }
      return true;
    },
    interrupt() {
      if (!inflight || inflight.turnId === PRIME_TURN || inflight.interrupted) return;
      inflight.interrupted = true;
      writeLine({ type: 'control_request', request_id: 'int-' + String(now()), request: { subtype: 'interrupt' } });
      clearInterruptTimer();
      interruptTimer = setT(interruptFallback, interruptTimeoutMs);
    },
    answerPermission(id, allow) {
      writeLine({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: id,
          response: allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied by voice user' },
        },
      });
    },
    async stop() {
      stopping = true;
      clearInterruptTimer();
      if (restartTimer !== null) { clearT(restartTimer); restartTimer = null; }
      const c = child;
      child = null;
      inflight = null;
      if (!c) return;
      const exited = new Promise<void>((resolve) => {
        if (c.exitCode !== null || c.signalCode !== null) { resolve(); return; }
        c.once('exit', () => resolve());
        c.once('error', () => resolve());
      });
      const wait = (ms: number): Promise<boolean> =>
        new Promise((resolve) => {
          const t = setT(() => resolve(false), ms);
          void exited.then(() => { clearT(t); resolve(true); });
        });
      try { c.stdin?.end(); } catch { /* ignore */ }
      if (await wait(killGraceMs)) return;
      killTree(c);
      await wait(killGraceMs);
    },
    on(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    state: () => state,
    pid: () => child?.pid ?? null,
  };
}
