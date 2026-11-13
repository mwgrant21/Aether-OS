import { frameComposerInput } from './composerInput';
import {
  GUI_MAX_WRITE_CHARS, GUI_SUBMIT_GAP_MS, GUI_CHANNELS, GUI_DEFAULT_PERMISSION_MODE, GUI_NEW_KEY, GUI_KILL_WAIT_MS, GUI_MAX_LIVE_SESSIONS, isGuiPermissionMode,
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
  /** One lifecycle per chat slot. */
  createLifecycle: () => GuiLifecycle;
  spawn: (a: { cwd?: string; cols: number; rows: number; mode: GuiPermissionMode; sessionId?: string; resumeId?: string; continueLast?: boolean }) => GuiPty;
  /** true = resume a known conversation with --resume <uuid>; false = fall back to --continue (cwd-scoped). */
  resumeById: boolean;
  projectPath: (id: string) => string | undefined;
  isDirectory: (p: string) => boolean;
  /** Aether-owned cwd for the New chat (projectId null). Absent = no cwd; present but undefined/non-directory = unavailable (fail closed). */
  newChatDir?: () => string | undefined;
  /** Payloads are keyed: data {key,d}, alive/exit {key}. */
  send: (channel: string, payload?: unknown) => void;
  randomUUID: () => string;
  schedule: (fn: () => void, ms: number) => () => void;
  log?: (l: string) => void;
}
export interface GuiSession {
  start(req: unknown): Promise<StartResult>; write(key: unknown, input: unknown): boolean; resize(key: unknown, c: unknown, r: unknown): void;
  submit(key: unknown, text: unknown): boolean; live(key: unknown): boolean; stop(key: unknown): void; dispose(): void;
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

// One slot per chat key. A slot exists (alive=false) from the synchronous cap check until its pty exits or the chat is stopped.
interface Slot {
  lifecycle: GuiLifecycle;
  gen: number; // id of the start whose handlers may forward
  alive: boolean; // false from stop()/exit even while lifecycle.current is still non-null (kill() does not null it until the pty exits)
  pendingEnter: boolean;
  cancelEnter: (() => void) | null;
  active: Tracked | null; // the pty this slot's lifecycle currently holds
}

export function createGuiSession(d: GuiSessionDeps): GuiSession {
  let seq = 0; // one monotonic id source across all slots, never rewound
  let disposed = false;
  // Conversation id per key (project id, or GUI_NEW_KEY). In memory only; stop/exit never clear it so an ended chat can resume.
  const resumeIds = new Map<string, string>();
  const slots = new Map<string, Slot>();
  const dying = new Map<string, Tracked>(); // per key: a killed pty whose exit has not fired yet; the next start of that key waits for it (bounded)

  const clearEnter = (s: Slot): void => {
    const c = s.cancelEnter;
    s.cancelEnter = null;
    s.pendingEnter = false;
    c?.();
  };
  const slotOf = (key: unknown): Slot | undefined => (typeof key === 'string' ? slots.get(key) : undefined);
  const isLive = (s: Slot | undefined): s is Slot => !!s && s.alive && s.lifecycle.current !== null;
  const killSlot = (s: Slot): void => { try { s.lifecycle.kill(); } catch { d.log?.('gui session: kill failed'); } };

  // Ends one slot's pty and frees the slot. seq only ever grows, so no handler of an earlier pty can forward again.
  function endSlot(key: string, s: Slot): void {
    s.gen = ++seq;
    clearEnter(s);
    s.alive = false;
    if (slots.get(key) === s) slots.delete(key);
    if (s.lifecycle.current === null) return;
    killSlot(s);
    if (s.active && !s.active.isGone()) dying.set(key, s.active);
  }
  function stop(key: unknown): void {
    if (typeof key !== 'string') return;
    const s = slots.get(key);
    if (s) endSlot(key, s);
  }

  // Resolves when the killed pty has exited or GUI_KILL_WAIT_MS has passed, whichever is first.
  const waitForExit = (t: Tracked): Promise<void> => new Promise((res) => {
    const cancel = d.schedule(res, GUI_KILL_WAIT_MS);
    void t.gone.then(() => { cancel(); res(); });
  });

  async function start(req: unknown): Promise<StartResult> {
    if (disposed) return { ok: false, reason: 'unavailable' };
    if (typeof req !== 'object' || req === null) return { ok: false, reason: 'bad-request' }; // no key to stop
    const { projectId, cols, rows, restart, resume, mode: reqMode } = req as Record<string, unknown>;
    const key = projectId === null ? GUI_NEW_KEY : typeof projectId === 'string' ? projectId : undefined;
    // A rejected start ends only the requested key's chat, never another key's.
    const reject = (reason: 'bad-request' | 'unknown-project' | 'missing-dir' | 'unavailable'): StartResult => { stop(key); return { ok: false, reason }; };
    if (key === undefined || !isDim(cols) || !isDim(rows)) return reject('bad-request');
    if (reqMode !== undefined && !isGuiPermissionMode(reqMode)) return reject('bad-request');
    const mode = reqMode ?? GUI_DEFAULT_PERMISSION_MODE;
    let cwd: string | undefined;
    if (projectId === null) {
      if (d.newChatDir) {
        cwd = d.newChatDir();
        if (cwd === undefined || !d.isDirectory(cwd)) return reject('unavailable');
      }
    } else {
      cwd = d.projectPath(key);
      if (cwd === undefined) return reject('unknown-project');
      if (!d.isDirectory(cwd)) return reject('missing-dir');
    }
    let slot = slots.get(key);
    if (restart !== true && isLive(slot)) {
      d.send(GUI_CHANNELS.alive, { key });
      return { ok: true, reused: true };
    }
    // The cap check and the slot insert are one synchronous section (no await before the insert), so two starts in the same tick cannot both pass.
    if (!slot) {
      if (slots.size >= GUI_MAX_LIVE_SESSIONS) return { ok: false, reason: 'too-many-live' }; // stops nothing
      slot = { lifecycle: d.createLifecycle(), gen: 0, alive: false, pendingEnter: false, cancelEnter: null, active: null };
      slots.set(key, slot);
    }
    const mine = slot;
    clearEnter(mine);
    const myGen = ++seq;
    mine.gen = myGen;
    // Kill this key's old pty first and, if it has not exited, wait for it so two claudes never share one conversation.
    if (mine.lifecycle.current !== null && mine.active && !mine.active.isGone() && dying.get(key) !== mine.active) {
      mine.alive = false;
      killSlot(mine);
      dying.set(key, mine.active);
    }
    const old = dying.get(key);
    if (old && !old.isGone()) {
      await waitForExit(old);
      if (myGen !== mine.gen || disposed || slots.get(key) !== mine) return { ok: false, reason: 'superseded' };
    }
    if (dying.get(key) === old) dying.delete(key);
    // Selector: fresh -> new id (recorded after the spawn succeeded); resume -> the known id, else --continue.
    const knownId = resume === true && d.resumeById ? resumeIds.get(key) : undefined;
    const freshId = resume === true ? undefined : d.randomUUID();
    const forwards = (): boolean => myGen === mine.gen && slots.get(key) === mine;
    let spawned: Tracked | null = null;
    try {
      mine.lifecycle.start(
        () => (spawned = trackExit(d.spawn(
          freshId !== undefined ? { cwd, cols, rows, mode, sessionId: freshId }
            : knownId !== undefined ? { cwd, cols, rows, mode, resumeId: knownId }
              : { cwd, cols, rows, mode, continueLast: true },
        ))).pty,
        {
          onData: (data) => { if (forwards()) d.send(GUI_CHANNELS.data, { key, d: data }); },
          onAlive: () => { if (forwards()) d.send(GUI_CHANNELS.alive, { key }); },
          onExit: () => {
            if (!forwards()) return;
            mine.alive = false;
            clearEnter(mine);
            slots.delete(key); // frees the slot for the cap
            d.send(GUI_CHANNELS.exit, { key });
          },
        },
        { cols, rows },
      );
    } catch {
      endSlot(key, mine); // a failed start leaves nothing live for THIS key; handlers of the failed new pty and the old one stay dropped
      if (spawned && !(spawned as Tracked).isGone()) dying.set(key, spawned);
      d.log?.('gui session: start failed');
      return { ok: false, reason: 'spawn-failed' };
    }
    mine.active = spawned;
    if (freshId !== undefined) resumeIds.set(key, freshId);
    mine.alive = true;
    return { ok: true, reused: false };
  }

  function write(key: unknown, input: unknown): boolean {
    const s = slotOf(key);
    if (disposed || !isLive(s) || typeof input !== 'string' || input.length > GUI_MAX_WRITE_CHARS) return false;
    s.lifecycle.write(input);
    return true;
  }

  function resize(key: unknown, c: unknown, r: unknown): void {
    const s = slotOf(key);
    if (disposed || !isDim(c) || !isDim(r) || !isLive(s)) return;
    s.lifecycle.resize(c, r);
  }

  function submit(key: unknown, text: unknown): boolean {
    const s = slotOf(key);
    if (disposed || typeof text !== 'string' || !isLive(s) || s.pendingEnter) return false;
    const framed = frameComposerInput(text);
    if (!framed.ok) return false;
    s.lifecycle.write(framed.writes[0]!);
    const rest = framed.writes.slice(1);
    if (rest.length > 0) {
      const g = s.gen;
      s.pendingEnter = true;
      s.cancelEnter = d.schedule(() => {
        s.cancelEnter = null;
        s.pendingEnter = false;
        if (g !== s.gen || disposed || !isLive(s)) return;
        for (const w of rest) s.lifecycle.write(w);
      }, GUI_SUBMIT_GAP_MS);
    }
    return true;
  }

  const live = (key: unknown): boolean => isLive(slotOf(key));

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    seq++;
    for (const [key, s] of [...slots]) endSlot(key, s);
  }

  return { start, write, resize, submit, live, stop, dispose };
}
