import { frameComposerInput } from './composerInput';
import {
  GUI_MAX_WRITE_CHARS, GUI_SUBMIT_GAP_MS, GUI_CHANNELS, GUI_DEFAULT_PERMISSION_MODE, GUI_NEW_KEY, GUI_KILL_WAIT_MS, isGuiPermissionMode,
  type GuiPermissionMode, type StartResult,
} from './guiTypes';

// Structural stand-ins for PtyLike / PtyLifecycle: this file must not import the pty modules (controlBoundary test).
export interface GuiPty { onData(cb: (d: string) => void): void; onExit(cb: () => void): void; kill(): void; write(i: string): void; resize(c: number, r: number): void; resume?(): void }
export interface GuiLifecycle {
  readonly current: unknown | null;
  start(spawn: () => GuiPty, h: { onData: (d: string) => void; onAlive: () => void; onExit: () => void }, size?: { cols: number; rows: number }): unknown;
  write(i: string): void; resize(c: number, r: number): void; kill(): void;
}
export interface GuiSessionDeps {
  lifecycle: GuiLifecycle;
  spawn: (a: { cwd?: string; cols: number; rows: number; mode: GuiPermissionMode; sessionId?: string; resumeId?: string; continueLast?: boolean }) => GuiPty;
  /** true = resume a known conversation with --resume <uuid>; false = fall back to --continue (cwd-scoped). */
  resumeById: boolean;
  projectPath: (id: string) => string | undefined;
  isDirectory: (p: string) => boolean;
  /** Aether-owned cwd for the New chat (projectId null). Absent = no cwd; present but undefined/non-directory = unavailable (fail closed). */
  newChatDir?: () => string | undefined;
  send: (channel: string, payload?: unknown) => void;
  randomUUID: () => string;
  schedule: (fn: () => void, ms: number) => () => void;
  log?: (l: string) => void;
}
export interface GuiSession {
  start(req: unknown): Promise<StartResult>; write(input: unknown): boolean; resize(c: unknown, r: unknown): void;
  submit(text: unknown): boolean; live(): boolean; stop(): void; dispose(): void;
}

// Forwards to the real pty and registers exactly ONE onExit on it (RemotePty keeps a single callback), so the session
// can tell when a killed pty has really gone. resume() is forwarded because PtyLifecycle calls it after wiring.
export function trackExit(p: GuiPty): { pty: GuiPty; gone: Promise<void>; isGone: () => boolean } {
  let isGone = false;
  let markGone: () => void = () => {};
  const gone = new Promise<void>((r) => { markGone = r; });
  const pty: GuiPty = {
    onData: (cb) => p.onData(cb),
    onExit: (cb) => p.onExit(() => { isGone = true; markGone(); cb(); }),
    kill: () => p.kill(),
    write: (i) => p.write(i),
    resize: (c, r) => p.resize(c, r),
    resume: () => (p as { resume?: () => void }).resume?.(),
  };
  return { pty, gone, isGone: () => isGone };
}
type Tracked = ReturnType<typeof trackExit>;

const isDim = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1000;

export function createGuiSession(d: GuiSessionDeps): GuiSession {
  let runningProjectId: string | null | undefined; // undefined = no session
  let gen = 0; // id of the session whose handlers may forward
  let seq = 0; // monotonic id source, never rewound
  let pendingEnter = false;
  let cancelEnter: (() => void) | null = null;
  let disposed = false;
  // Conversation id per key (project id, or GUI_NEW_KEY). In memory only; stop/exit never clear it so an ended chat can resume.
  const resumeIds = new Map<string, string>();
  let active: Tracked | null = null; // the pty the lifecycle currently holds
  let dying: Tracked | null = null;  // a killed pty whose exit has not fired yet: the next start waits for it (bounded)
  let alive = false; // false from stop()/exit even while lifecycle.current is still non-null (kill() does not null it until the pty exits)

  const clearEnter = (): void => {
    const c = cancelEnter;
    cancelEnter = null;
    pendingEnter = false;
    c?.();
  };
  const live = (): boolean => alive && d.lifecycle.current !== null;

  // Ends whatever GUI pty is running. seq only ever grows, so no handler of an earlier pty can forward again.
  function stop(): void {
    gen = ++seq;
    clearEnter();
    runningProjectId = undefined;
    alive = false;
    if (d.lifecycle.current === null) return;
    try { d.lifecycle.kill(); } catch { d.log?.('gui session: kill failed'); }
    if (active && !active.isGone()) dying = active;
  }

  // Resolves when the killed pty has exited or GUI_KILL_WAIT_MS has passed, whichever is first.
  const waitForExit = (t: Tracked): Promise<void> => new Promise((res) => {
    const cancel = d.schedule(res, GUI_KILL_WAIT_MS);
    void t.gone.then(() => { cancel(); res(); });
  });

  async function start(req: unknown): Promise<StartResult> {
    if (disposed) return { ok: false, reason: 'unavailable' };
    if (typeof req !== 'object' || req === null) { stop(); return { ok: false, reason: 'bad-request' }; }
    const { projectId, cols, rows, restart, resume, mode: reqMode } = req as Record<string, unknown>;
    if (!(projectId === null || typeof projectId === 'string') || !isDim(cols) || !isDim(rows)) { stop(); return { ok: false, reason: 'bad-request' }; }
    if (reqMode !== undefined && !isGuiPermissionMode(reqMode)) { stop(); return { ok: false, reason: 'bad-request' }; }
    const mode = reqMode ?? GUI_DEFAULT_PERMISSION_MODE;
    const key = projectId ?? GUI_NEW_KEY;
    let cwd: string | undefined;
    if (projectId === null) {
      if (d.newChatDir) {
        cwd = d.newChatDir();
        if (cwd === undefined || !d.isDirectory(cwd)) { stop(); return { ok: false, reason: 'unavailable' }; }
      }
    } else {
      cwd = d.projectPath(projectId);
      if (cwd === undefined) { stop(); return { ok: false, reason: 'unknown-project' }; }
      if (!d.isDirectory(cwd)) { stop(); return { ok: false, reason: 'missing-dir' }; }
    }
    if (restart !== true && live() && runningProjectId === projectId) {
      d.send(GUI_CHANNELS.alive);
      return { ok: true, reused: true };
    }
    clearEnter();
    const myGen = ++seq;
    gen = myGen;
    // Kill the old pty first and, if it has not exited, wait for it so two claudes never share one conversation.
    if (d.lifecycle.current !== null && active && !active.isGone() && dying !== active) {
      alive = false;
      runningProjectId = undefined;
      try { d.lifecycle.kill(); } catch { d.log?.('gui session: kill failed'); }
      dying = active;
    }
    if (dying && !dying.isGone()) {
      await waitForExit(dying);
      if (myGen !== gen || disposed) return { ok: false, reason: 'superseded' };
    }
    dying = null;
    // Selector: fresh -> new id (recorded after the spawn succeeded); resume -> the known id, else --continue.
    const knownId = resume === true && d.resumeById ? resumeIds.get(key) : undefined;
    const freshId = resume === true ? undefined : d.randomUUID();
    let spawned: Tracked | null = null;
    try {
      d.lifecycle.start(
        () => (spawned = trackExit(d.spawn(
          freshId !== undefined ? { cwd, cols, rows, mode, sessionId: freshId }
            : knownId !== undefined ? { cwd, cols, rows, mode, resumeId: knownId }
              : { cwd, cols, rows, mode, continueLast: true },
        ))).pty,
        {
          onData: (data) => { if (myGen === gen) d.send(GUI_CHANNELS.data, data); },
          onAlive: () => { if (myGen === gen) d.send(GUI_CHANNELS.alive); },
          onExit: () => {
            if (myGen !== gen) return;
            runningProjectId = undefined;
            alive = false;
            clearEnter();
            d.send(GUI_CHANNELS.exit);
          },
        },
        { cols, rows },
      );
    } catch {
      stop(); // a failed start leaves nothing live; handlers of the failed new pty and the old one stay dropped
      if (spawned && !(spawned as Tracked).isGone()) dying = spawned;
      d.log?.('gui session: start failed');
      return { ok: false, reason: 'spawn-failed' };
    }
    active = spawned;
    if (freshId !== undefined) resumeIds.set(key, freshId);
    runningProjectId = projectId;
    alive = true;
    return { ok: true, reused: false };
  }

  function write(input: unknown): boolean {
    if (disposed || typeof input !== 'string' || input.length > GUI_MAX_WRITE_CHARS || !live()) return false;
    d.lifecycle.write(input);
    return true;
  }

  function resize(c: unknown, r: unknown): void {
    if (disposed || !isDim(c) || !isDim(r) || !live()) return;
    d.lifecycle.resize(c, r);
  }

  function submit(text: unknown): boolean {
    if (disposed || typeof text !== 'string' || !live() || pendingEnter) return false;
    const framed = frameComposerInput(text);
    if (!framed.ok) return false;
    d.lifecycle.write(framed.writes[0]!);
    const rest = framed.writes.slice(1);
    if (rest.length > 0) {
      const g = gen;
      pendingEnter = true;
      cancelEnter = d.schedule(() => {
        cancelEnter = null;
        pendingEnter = false;
        if (g !== gen || disposed || !live()) return;
        for (const w of rest) d.lifecycle.write(w);
      }, GUI_SUBMIT_GAP_MS);
    }
    return true;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    gen = ++seq;
    clearEnter();
    alive = false;
    try { d.lifecycle.kill(); } catch { d.log?.('gui session: kill failed'); }
  }

  return { start, write, resize, submit, live, stop, dispose };
}
