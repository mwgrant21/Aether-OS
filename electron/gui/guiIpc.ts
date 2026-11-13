import type { IpcMain } from 'electron';
import type { createProjectsStore } from './projectsStore';
import type { GuiSession } from './guiSession';
import { GUI_CHANNELS, type AddProjectResult, type StartResult, type UiProject } from './guiTypes';

type Store = ReturnType<typeof createProjectsStore>;
type Sender = { sender: unknown; senderFrame: unknown };

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
    // A project start needs the store (path lookup); the home-dir "New" chat does not.
    if (typeof projectId === 'string' && !(await o.getStore())) {
      o.session.stop(); // this rejection never reaches session.start, so end the live chat here (trusted senders only)
      return { ok: false, reason: 'unavailable' };
    }
    return o.session.start(req);
  });

  ipc.handle(C.submit, (e, text: unknown): boolean => (o.isTrusted(e) ? o.session.submit(text) : false));

  ipc.on(C.write, (e, input: unknown) => {
    if (!o.isTrusted(e)) return;
    o.session.write(input);
  });

  ipc.on(C.resize, (e, size: unknown) => {
    if (!o.isTrusted(e)) return;
    const s = typeof size === 'object' && size !== null ? (size as { cols?: unknown; rows?: unknown }) : {};
    o.session.resize(s.cols, s.rows);
  });
}
