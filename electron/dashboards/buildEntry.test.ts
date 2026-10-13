import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The registered command points at out/main/aether-data-mcp.js. If this entry
// disappears from the build, registration silently breaks at Claude startup.
describe('electron-vite build', () => {
  it('builds the aether-data MCP entry', () => {
    const config = readFileSync(join(__dirname, '..', '..', 'electron.vite.config.ts'), 'utf8');
    expect(config).toContain("'aether-data-mcp': resolve(__dirname, 'electron/dashboards/dataServerEntry.ts')");
  });
});
