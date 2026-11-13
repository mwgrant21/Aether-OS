// Pure launch-line helper for the GUI chat pty. It must not import the pty modules (controlBoundary test);
// main.ts passes the base command from buildClaudeLaunchCommand.

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
