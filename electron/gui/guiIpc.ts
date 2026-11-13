import type { IpcMain } from 'electron';
import type { createProjectsStore } from './projectsStore';
import type { GuiSession } from './guiSession';
import { GUI_CHANNELS, GUI_NEW_KEY, type AddProjectResult, type StartResult, type UiProject } from './guiTypes';

type Store = ReturnType<typeof createProjectsStore>;
type Sender = { sender: unknown; senderFrame: unknown };
// A chat key is a project id or GUI_NEW_KEY: a string of 1-64 chars.
const isKey = (k: unknown): k is string => typeof k === 'string' && k.length >= 1 && k.length <= 64;

export interface GuiIpcDeps {
  isTrusted: (e: Sender) => boolean;
  /** null = the private ~/.aether-os dir ACL was not confirmed: fail closed. */
  getStore: () => Promise<Store | null>;
  session: GuiSession;
  /** The only way a path enters the app: the native folder picker. Never reaches the renderer. */
  pickFolder: () => Promise<string | null>;
}

/** gui:* channels. Every handler checks the sender first; payloads are `unknown` and validated
 *  by the session/store. Results carry ids, names and reasons only, never a path. */
export function registerGuiIpc(ipc: Pick<IpcMain, 'handle' | 'on'>, o: GuiIpcDeps): void {
  const C = GUI_CHANNELS;

  ipc.handle(C.projectsList, async (e): Promise<UiProject[]> => {
    if (!o.isTrusted(e)) return [];
    const store = await o.getStore();
    return store ? store.list() : [];
  });

  ipc.handle(C.projectsAdd, async (e): Promise<AddProjectResult> => {
    if (!o.isTrusted(e)) return { ok: false, reason: 'canceled' };
    const store = await o.getStore();
    if (!store) return { ok: false, reason: 'unavailable' };
    const picked = await o.pickFolder();
    if (picked === null) return { ok: false, reason: 'canceled' };
    return store.add(picked);
  });

  ipc.handle(C.projectsRemove, async (e, id: unknown): Promise<boolean> => {
    if (!o.isTrusted(e) || typeof id !== 'string') return false;
    const store = await o.getStore();
    return store ? store.remove(id) : false;
  });

  ipc.handle(C.start, async (e, req: unknown): Promise<StartResult> => {
    if (!o.isTrusted(e)) return { ok: false, reason: 'bad-request' };
    const projectId = typeof req === 'object' && req !== null ? (req as { projectId?: unknown }).projectId : undefined;
    // Both a project start (path lookup) and the New chat (owned folder, created only after the private-dir ACL settled) need the store.
    if ((typeof projectId === 'string' || projectId === null) && !(await o.getStore())) {
      const key = projectId ?? GUI_NEW_KEY;
      if (isKey(key)) o.session.stop(key); // this rejection never reaches session.start, so end THIS key's chat here (trusted senders only); other keys are untouched
      return { ok: false, reason: 'unavailable' };
    }
    return o.session.start(req);
  });

  ipc.handle(C.submit, (e, key: unknown, text: unknown): boolean => (o.isTrusted(e) && isKey(key) ? o.session.submit(key, text) : false));

  ipc.on(C.stop, (e, key: unknown) => {
    if (!o.isTrusted(e) || !isKey(key)) return;
    o.session.stop(key);
  });

  ipc.on(C.write, (e, key: unknown, input: unknown) => {
    if (!o.isTrusted(e) || !isKey(key)) return;
    o.session.write(key, input);
  });

  ipc.on(C.resize, (e, key: unknown, size: unknown) => {
    if (!o.isTrusted(e) || !isKey(key)) return;
    const s = typeof size === 'object' && size !== null ? (size as { cols?: unknown; rows?: unknown }) : {};
    o.session.resize(key, s.cols, s.rows);
  });
}
