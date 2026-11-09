// Starts or finds the detached pty-owner helper and connects the client to it. Pure of electron
// and node-pty: every side effect (spawn, fs, liveness probe, clock) is injected.
// ESM requirement: the helper entry (out/main/pty-owner.js) is an ES module, so it only loads
// when the nearest package.json above it has "type":"module". out/main under the repo root and
// under app.asar both do; a bare directory parses as CJS and the import fails.
// The caller (main) chooses entryPath; this module never computes paths.
// Safety rule: a helper that is busy or unreachable is never orphaned or doubled. The discovery
// file is removed only when its pid is dead.
import { spawn as nodeSpawn } from 'node:child_process';
import type { OwnerClient } from './ownerClient';
import { decodeDiscovery } from './protocol';

const DEFAULT_GRACE_MS = '900000'; // 15 min, set explicitly so the launch never relies on the helper's own default
const PASSTHROUGH = [
  'SystemRoot', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'ComSpec',
] as const;

const posIntString = (v: string | undefined): string | undefined => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isSafeInteger(n) && n > 0 ? String(n) : undefined;
};

/** Allowlisted env for the helper. A NEW object; never a spread of `source` (the shells get their env from the spawn spec). */
export function minimalHelperEnv(
  source: NodeJS.ProcessEnv = process.env,
  o: { discoveryPath: string },
): Record<string, string> {
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    AETHER_PTY_OWNER_DISCOVERY: o.discoveryPath,
    AETHER_PTY_OWNER_GRACE_MS: posIntString(source.AETHER_PTY_OWNER_GRACE_MS) ?? DEFAULT_GRACE_MS,
  };
  const idle = posIntString(source.AETHER_PTY_OWNER_IDLE_MS);
  if (idle !== undefined) env.AETHER_PTY_OWNER_IDLE_MS = idle;
  for (const k of PASSTHROUGH) {
    const v = source[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export interface LaunchedChild { on(event: 'error', cb: (e: Error) => void): unknown; unref(): void }
export type LauncherSpawn = (
  file: string, args: string[],
  options: { detached: true; stdio: 'ignore'; windowsHide: true; env: Record<string, string> },
) => LaunchedChild;

export interface EnsureOwnerDeps {
  client: Pick<OwnerClient, 'connect' | 'ready'>;
  discoveryPath: string;
  execPath: string;
  entryPath: string;
  spawn?: LauncherSpawn;
  fs: {
    existsSync(p: string): boolean;
    readFileSync(p: string, enc: 'utf8'): string;
    rmSync(p: string, o: { force: true }): void;
  };
  isAlive(pid: number): boolean;
  env: NodeJS.ProcessEnv;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Fixed-string diag lines only. */
  log(line: string): void;
  launchWaitMs?: number;
  pollMs?: number;
}

/**
 * busy / bad proof / timeout (and any unrecognised error) mean a helper that may be live: leave it.
 * closed / unreadable file: the pid decides.
 */
function pidDecides(err: unknown): boolean {
  const m = err instanceof Error ? err.message : '';
  return m === 'closed' || m === 'bad discovery file' || m === 'bad frame' || m.includes('ENOENT');
}

/** Never throws. True iff the client is connected and claimed. */
export async function ensureOwner(deps: EnsureOwnerDeps): Promise<boolean> {
  const { client, discoveryPath, fs: dfs, log } = deps;
  try {
    if (dfs.existsSync(discoveryPath)) {
      try {
        await client.connect(discoveryPath);
        return client.ready;
      } catch (e) {
        if (!pidDecides(e)) { log('pty-owner: helper present but not usable, left alone'); return false; }
        let pid: number | undefined;
        try { pid = decodeDiscovery(dfs.readFileSync(discoveryPath, 'utf8'))?.pid; } catch { pid = undefined; }
        if (pid !== undefined && deps.isAlive(pid)) { log('pty-owner: helper alive but unreachable, left alone'); return false; }
        dfs.rmSync(discoveryPath, { force: true });
        log('pty-owner: stale discovery file removed');
      }
    }
    const spawn = deps.spawn ?? (nodeSpawn as unknown as LauncherSpawn);
    const child = spawn(deps.execPath, [deps.entryPath], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: minimalHelperEnv(deps.env, { discoveryPath }),
    });
    child.on('error', () => log('pty-owner: helper spawn error'));
    child.unref();
    const pollMs = deps.pollMs ?? 50;
    const end = deps.now() + (deps.launchWaitMs ?? 5000);
    while (!dfs.existsSync(discoveryPath) && deps.now() < end) await deps.sleep(pollMs);
    if (!dfs.existsSync(discoveryPath)) { log('pty-owner: helper did not publish a discovery file'); return false; }
    await client.connect(discoveryPath);
    return client.ready;
  } catch {
    log('pty-owner: launch failed');
    return false;
  }
}
