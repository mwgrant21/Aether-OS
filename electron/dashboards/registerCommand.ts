export const DATA_SERVER_ENTRY_FILE = 'aether-data-mcp.js';

/**
 * Clipboard text the operator pastes into a terminal to opt in. Aether never
 * runs it. The server name comes before `-e` because claude's `-e` takes a
 * variable number of values; the `--` then ends the option list.
 */
export function buildRegisterCommand(execPath: string, entryPath: string): string {
  return `claude mcp add aether-data --scope user -e ELECTRON_RUN_AS_NODE=1 -- "${execPath}" "${entryPath}"`;
}
