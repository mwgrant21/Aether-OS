import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const scriptPath = fileURLToPath(new URL('./aether-hook-emit.mjs', import.meta.url));

function runScript(stdin: string, homeDir: string) {
  return spawnSync('node', [scriptPath], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
  });
}

describe('aether-hook-emit.mjs', () => {
  it('appends the raw stdin line to the session spool file and exits 0', () => {
    const home = mkdtempSync(join(tmpdir(), 'aether-hook-emit-'));
    const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-abc' });
    const result = runScript(payload, home);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const spoolFile = join(home, '.aether-os', 'spool', 'sess-abc.jsonl');
    expect(existsSync(spoolFile)).toBe(true);
    expect(readFileSync(spoolFile, 'utf8')).toBe(payload + '\n');
  });

  it('appends a second event to the SAME session file rather than overwriting', () => {
    const home = mkdtempSync(join(tmpdir(), 'aether-hook-emit-'));
    const p1 = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-xyz', tool_name: 'Bash' });
    const p2 = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'sess-xyz', tool_name: 'Bash' });
    runScript(p1, home);
    runScript(p2, home);

    const spoolFile = join(home, '.aether-os', 'spool', 'sess-xyz.jsonl');
    expect(readFileSync(spoolFile, 'utf8')).toBe(p1 + '\n' + p2 + '\n');
  });

  it('exits 0 with no stderr on malformed JSON stdin, and still writes to a fallback file', () => {
    const home = mkdtempSync(join(tmpdir(), 'aether-hook-emit-'));
    const result = runScript('not json{{', home);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const fallback = join(home, '.aether-os', 'spool', 'unknown-session.jsonl');
    expect(existsSync(fallback)).toBe(true);
  });

  it('exits 0 with no stderr on completely empty stdin', () => {
    const home = mkdtempSync(join(tmpdir(), 'aether-hook-emit-'));
    const result = runScript('', home);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('falls back to unknown-session.jsonl when session_id is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'aether-hook-emit-'));
    const payload = JSON.stringify({ hook_event_name: 'Stop' });
    runScript(payload, home);
    const fallback = join(home, '.aether-os', 'spool', 'unknown-session.jsonl');
    expect(existsSync(fallback)).toBe(true);
  });
});
