import { frameComposerInput } from './composerInput';
import { GUI_MAX_WRITE_CHARS, GUI_SUBMIT_GAP_MS, GUI_CHANNELS, type StartResult } from './guiTypes';

// Structural stand-ins for PtyLike / PtyLifecycle: this file must not import the pty modules (controlBoundary test).
export interface GuiPty { onData(cb: (d: string) => void): void; onExit(cb: () => void): void; kill(): void; write(i: string): void; resize(c: number, r: number): void }
export interface GuiLifecycle {
  readonly current: unknown | null;
  start(spawn: () => GuiPty, h: { onData: (d: string) => void; onAlive: () => void; onExit: () => void }, size?: { cols: number; rows: number }): unknown;
  write(i: string): void; resize(c: number, r: number): void; kill(): void;
}
export interface GuiSessionDeps {
  lifecycle: GuiLifecycle;
  spawn: (a: { cwd?: string; cols: number; rows: number; sessionId: string }) => GuiPty;
  projectPath: (id: string) => string | undefined;
  isDirectory: (p: string) => boolean;
  send: (channel: string, payload?: unknown) => void;
  randomUUID: () => string;
  schedule: (fn: () => void, ms: number) => () => void;
  log?: (l: string) => void;
}
export interface GuiSession {
  start(req: unknown): StartResult; write(input: unknown): boolean; resize(c: unknown, r: unknown): void;
  submit(text: unknown): boolean; live(): boolean; dispose(): void;
}

const isDim = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1000;

export function createGuiSession(d: GuiSessionDeps): GuiSession {
  let runningProjectId: string | null | undefined; // undefined = no session
  let gen = 0;
  let pendingEnter = false;
  let cancelEnter: (() => void) | null = null;
  let disposed = false;

  const clearEnter = (): void => {
    const c = cancelEnter;
    cancelEnter = null;
    pendingEnter = false;
    c?.();
  };
  const live = (): boolean => d.lifecycle.current !== null;

  function start(req: unknown): StartResult {
    if (disposed) return { ok: false, reason: 'unavailable' };
    if (typeof req !== 'object' || req === null) return { ok: false, reason: 'bad-request' };
    const { projectId, cols, rows } = req as Record<string, unknown>;
    if (!(projectId === null || typeof projectId === 'string') || !isDim(cols) || !isDim(rows)) return { ok: false, reason: 'bad-request' };
    let cwd: string | undefined;
    if (projectId !== null) {
      cwd = d.projectPath(projectId);
      if (cwd === undefined) return { ok: false, reason: 'unknown-project' };
      if (!d.isDirectory(cwd)) return { ok: false, reason: 'missing-dir' };
    }
    if (live() && runningProjectId === projectId) {
      d.send(GUI_CHANNELS.alive);
      return { ok: true, reused: true };
    }
    clearEnter();
    gen += 1;
    const myGen = gen;
    try {
      d.lifecycle.start(
        () => d.spawn({ cwd, cols, rows, sessionId: d.randomUUID() }),
        {
          onData: (data) => { if (myGen === gen) d.send(GUI_CHANNELS.data, data); },
          onAlive: () => { if (myGen === gen) d.send(GUI_CHANNELS.alive); },
          onExit: () => {
            if (myGen !== gen) return;
            runningProjectId = undefined;
            clearEnter();
            d.send(GUI_CHANNELS.exit);
          },
        },
        { cols, rows },
      );
    } catch {
      d.log?.('gui session: start failed');
      return { ok: false, reason: 'spawn-failed' };
    }
    runningProjectId = projectId;
    return { ok: true, reused: false };
  }

  function write(input: unknown): boolean {
    if (disposed || typeof input !== 'string' || input.length > GUI_MAX_WRITE_CHARS || !live()) return false;
    d.lifecycle.write(input);
    return true;
  }

  function resize(c: unknown, r: unknown): void {
    if (disposed || !isDim(c) || !isDim(r)) return;
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
    gen += 1;
    clearEnter();
    try { d.lifecycle.kill(); } catch { d.log?.('gui session: kill failed'); }
  }

  return { start, write, resize, submit, live, dispose };
}
