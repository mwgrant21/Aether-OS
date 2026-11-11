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

function runScript(
  homeDir: string,
  extraEnv: Record<string, string> = {},
  payload: unknown = { session_id: 's1', model: { display_name: 'Opus' } },
  extraArgs: string[] = [],
) {
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ...extraEnv };
  if (!('AETHER_STATUSLINE_NO_PERSIST' in extraEnv)) delete env.AETHER_STATUSLINE_NO_PERSIST;
  return spawnSync('node', [scriptPath, ...extraArgs], {
    input: JSON.stringify(payload),
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

describe('aether-statusline.mjs context warning', () => {
  const usage = (input: number, creation: number, read: number) => ({
    session_id: 's1',
    model: { display_name: 'Opus' },
    context_window: { current_usage: { input_tokens: input, output_tokens: 999_999, cache_creation_input_tokens: creation, cache_read_input_tokens: read } },
  });
  const run = (payload: unknown, args: string[] = []) => {
    const home = mkdtempSync(join(tmpdir(), 'aether-statusline-'));
    homes.push(home);
    return runScript(home, { AETHER_STATUSLINE_NO_PERSIST: '1' }, payload, args);
  };
  // The chained command must read stdin to its end: runChainedCommand pipes the payload in, and a
  // chain that exits without reading it can lose the line to EPIPE on Linux/macOS.
  const chain = ['--chain', Buffer.from(`node -e "process.stdin.resume();process.stdin.on('end',()=>console.log('CHAINED'))"`).toString('base64')];

  it('warns at or over the threshold', () => {
    const r = run(usage(10, 50_000, 260_000));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('WARN ctx 310K - handoff, then /clear');
    expect(r.stderr).toBe('');
  });

  it('does not warn just under the threshold, and ignores output tokens', () => {
    expect(run(usage(1, 99_998, 200_000)).stdout).not.toContain('WARN');
  });

  it('clamps negative fields to 0 instead of letting them cancel real usage', () => {
    const r = run(usage(-100_000, 0, 350_000));
    expect(r.stdout).toContain('WARN ctx 350K - handoff, then /clear');
  });

  it('caps an absurd context size in the displayed warning', () => {
    const r = run(usage(1, 1, 1e15));
    expect(r.stdout).toContain('WARN ctx 9999K - handoff, then /clear');
  });

  it('does not warn or fail when current_usage is null or malformed', () => {
    for (const cu of [null, 'x', [], { input_tokens: 'a', cache_read_input_tokens: { n: 1 }, cache_creation_input_tokens: -5 }]) {
      const r = run({ model: { display_name: 'Opus' }, context_window: { current_usage: cu } });
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('WARN');
      expect(r.stderr).toBe('');
    }
  });

  it('appends the warning to a chained line, and leaves it verbatim under threshold', () => {
    const over = run(usage(1, 1, 400_000), chain);
    expect(over.stdout.startsWith('CHAINED')).toBe(true);
    expect(over.stdout.trim().endsWith('WARN ctx 400K - handoff, then /clear')).toBe(true);
    expect(run(usage(1, 1, 10), chain).stdout.trim()).toBe('CHAINED');
  });

  it('keeps the warning when the line is truncated to 60 chars', () => {
    const p = usage(1, 1, 400_000);
    p.model.display_name = 'M'.repeat(100);
    const r = run(p);
    expect(r.stdout).toContain('WARN ctx');
    expect(r.stdout).toContain('M'.repeat(60));
    expect(r.stdout).not.toContain('M'.repeat(61));
  });
});
