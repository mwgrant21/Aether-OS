// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const scriptPath = fileURLToPath(new URL('./aether-statusline.mjs', import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function runScript(homeDir: string, extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ...extraEnv };
  if (!('AETHER_STATUSLINE_NO_PERSIST' in extraEnv)) delete env.AETHER_STATUSLINE_NO_PERSIST;
  return spawnSync('node', [scriptPath], {
    input: JSON.stringify({ session_id: 's1', model: { display_name: 'Opus' } }),
    encoding: 'utf8',
    env,
  });
}

describe('aether-statusline.mjs persistence', () => {
  it('persists the shared snapshot normally, but only renders the line in an unmonitored terminal', () => {
    const normal = mkdtempSync(join(tmpdir(), 'aether-statusline-'));
    const unmonitored = mkdtempSync(join(tmpdir(), 'aether-statusline-'));
    homes.push(normal, unmonitored);
    const a = runScript(normal);
    const b = runScript(unmonitored, { AETHER_STATUSLINE_NO_PERSIST: '1' });
    expect(a.status).toBe(0);
    expect(existsSync(join(normal, '.aether-os', 'statusline.json'))).toBe(true);
    expect(b.status).toBe(0);
    expect(b.stdout.trim()).toBe(a.stdout.trim());
    expect(existsSync(join(unmonitored, '.aether-os', 'statusline.json'))).toBe(false);
  });
});
