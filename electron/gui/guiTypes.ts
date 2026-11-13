export interface UiProject { id: string; name: string }          // name = basename only; never a path
export type AddProjectResult =
  | { ok: true; project: UiProject }
  | { ok: false; reason: 'canceled' | 'not-a-directory' | 'duplicate' | 'too-many' | 'write-failed' | 'unavailable' }; // unavailable = private dir ACL not confirmed (fail closed)
export type StartRequest = { projectId: string | null; cols: number; rows: number; restart?: boolean; resume?: boolean; mode?: GuiPermissionMode }; // null = "New" chat; restart = replace a live session instead of reusing it
export type StartResult =
  | { ok: true; reused: boolean }                                 // reused = same project already live; nothing restarted
  | { ok: false; reason: 'bad-request' | 'unknown-project' | 'missing-dir' | 'spawn-failed' | 'unavailable' | 'superseded' | 'too-many-live' }; // too-many-live = GUI_MAX_LIVE_SESSIONS chats already live; superseded = a later start/stop/dispose arrived while this start waited for the old pty to exit
export const GUI_CHANNELS = {
  projectsList: 'gui:projects:list', projectsAdd: 'gui:projects:add', projectsRemove: 'gui:projects:remove',
  start: 'gui:session:start', stop: 'gui:session:stop', write: 'gui:session:write', resize: 'gui:session:resize', submit: 'gui:session:submit',
  data: 'gui:session:data', alive: 'gui:session:alive', exit: 'gui:session:exit',
} as const;
// Wire payloads main -> renderer: every session event names the chat it belongs to.
export type GuiDataPayload = { key: string; d: string };
export type GuiKeyPayload = { key: string }; // alive / exit
export const GUI_MAX_LIVE_SESSIONS = 4;   // live chats at once (slots, including one still waiting for its predecessor to exit)
export const GUI_MAX_PROJECTS = 50;
export const GUI_SUBMIT_GAP_MS = 50;       // pause between the paste block and the Enter of a multi-line submit
export const GUI_MAX_WRITE_CHARS = 65536;  // cap on one raw write from the renderer
export const GUI_MAX_COMPOSER_CHARS = 20000;
export const GUI_READY_QUIET_MS = 1500;    // composer enables after this much PTY silence following first output
export const GUI_READY_CEILING_MS = 8000;  // ...or this long after first output at the latest, even if output never goes quiet
export const GUI_KILL_WAIT_MS = 2000;      // a replacing start waits at most this long for the killed pty to exit before spawning
export const GUI_NO_OUTPUT_HINT_MS = 15000; // no output at all this long after start: show a hint (composer stays disabled)
// Closed allow-list of CLI permission modes the GUI may pass to claude. Anything else is refused.
export const GUI_PERMISSION_MODES = ['manual', 'acceptEdits', 'plan', 'auto'] as const;
export type GuiPermissionMode = (typeof GUI_PERMISSION_MODES)[number];
export const GUI_DEFAULT_PERMISSION_MODE: GuiPermissionMode = 'auto';
export const isGuiPermissionMode = (v: unknown): v is GuiPermissionMode =>
  typeof v === 'string' && (GUI_PERMISSION_MODES as readonly string[]).includes(v);
export const GUI_NEW_KEY = 'new';          // per-key conversation key of the New chat (project ids are UUIDs, so no collision)
export const GUI_RESUME_BY_ID = true;      // probe P2 (2026-11-12): --resume <uuid> keeps the id and combines with --permission-mode; false would fall back to --continue
