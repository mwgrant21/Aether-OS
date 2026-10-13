import { describe, expect, it } from 'vitest';
import { buildRegisterCommand } from './registerCommand';

describe('buildRegisterCommand', () => {
  it('registers aether-data with Electron running as node, name first so -e cannot swallow it', () => {
    const exe = String.raw`C:\Apps\Aether OS\Aether OS.exe`;
    const entry = String.raw`C:\Apps\Aether OS\resources\app.asar\out\main\aether-data-mcp.js`;
    expect(buildRegisterCommand(exe, entry)).toBe(
      String.raw`claude mcp add aether-data --scope user -e ELECTRON_RUN_AS_NODE=1 -- "C:\Apps\Aether OS\Aether OS.exe" "C:\Apps\Aether OS\resources\app.asar\out\main\aether-data-mcp.js"`,
    );
  });
});
