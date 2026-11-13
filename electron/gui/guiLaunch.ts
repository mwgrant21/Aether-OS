// Pure launch-line helper for the GUI chat pty. It must not import the pty modules (controlBoundary test);
// main.ts passes the base command from buildClaudeLaunchCommand.
import { isGuiPermissionMode, type GuiPermissionMode } from './guiTypes';

// Env markers a parent Claude session leaves behind that change how the child behaves. Allow-list of ONE:
// CLAUDE_CODE_CHILD_SESSION is the marker behind "Transcript saving is off". The other CLAUDE_CODE_* names
// (ENTRYPOINT, EXECPATH, SESSION_*, MESSAGING_*) may carry auth/IPC identity, so they are left alone.
export const GUI_CHILD_ENV_MARKERS = ['CLAUDE_CODE_CHILD_SESSION'] as const;

// Prefixes the launch line with an unset of each marker. This only touches the GUI chat's own shell line,
// never buildPtyEnv, so the three terminals and the bridge keep their environment.
export function guiLaunchCommand(base: string, platform: NodeJS.Platform): string {
  const prefix = GUI_CHILD_ENV_MARKERS.map((name) =>
    platform === 'win32' ? `Remove-Item Env:\\${name} -ErrorAction SilentlyContinue; ` : `unset ${name}; `,
  ).join('');
  return prefix + base;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GuiClaudeCommandOptions {
  mode: GuiPermissionMode;
  sessionId?: string;     // fresh conversation with this id
  resumeId?: string;      // resume this conversation by id
  continueLast?: boolean; // continue the most recent conversation in the cwd
}

// Builds the GUI's claude launch line. At most one conversation selector; mode and ids are validated so nothing
// unchecked reaches the shell line.
export function buildGuiClaudeCommand(o: GuiClaudeCommandOptions): string {
  if (!isGuiPermissionMode(o.mode)) throw new Error('invalid permission mode');
  const selectors = [o.sessionId !== undefined, o.resumeId !== undefined, o.continueLast === true].filter(Boolean).length;
  if (selectors > 1) throw new Error('at most one of sessionId, resumeId, continueLast');
  const checkId = (id: string): string => {
    if (!UUID_RE.test(id)) throw new Error('invalid conversation id');
    return id;
  };
  let selector = '';
  if (o.sessionId !== undefined) selector = ` --session-id ${checkId(o.sessionId)}`;
  else if (o.resumeId !== undefined) selector = ` --resume ${checkId(o.resumeId)}`;
  else if (o.continueLast === true) selector = ' --continue';
  return `claude${selector} --permission-mode ${o.mode}; exit\r`;
}
