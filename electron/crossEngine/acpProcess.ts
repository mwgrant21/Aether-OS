import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const REQUIRED_OS_VARS = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
];

/** Dedicated Codex home: isolates Aether from any globally configured
 *  OpenAI API-key login, custom model providers, or unrelated MCP servers. */
export function resolveCodexHome(): string {
  const dir = join(homedir(), '.aether-os', 'codex-home');
  // The adapter process expects CODEX_HOME to already exist -- nothing else
  // in this module ever creates it, so a first-run canary attempt would fail
  // opaquely deep inside the spawned adapter otherwise.
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Never starts from process.env and removes keys -- builds an allowlist
 *  from nothing, so a newly invented billing-bypass env var is excluded by
 *  default rather than requiring this function to be updated to block it. */
export function buildCodexChildEnv(osEnv: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const key of REQUIRED_OS_VARS) {
    if (osEnv[key] !== undefined) child[key] = osEnv[key];
  }
  child.CODEX_HOME = codexHome;
  // spawnAcpProcess() below spawns process.execPath. Under a plain Node
  // process (every test, every prior manual smoke test) that's node.exe, so
  // this has no effect. Under Electron's own main process -- the only real
  // caller -- process.execPath is electron.exe, and spawning it against a
  // .js script path without this flag launches Electron itself rather than
  // running the script as plain Node, which is why the adapter appeared to
  // "flash a console window and exit instantly" only when driven from the
  // real running app, never from a terminal. Harmless outside Electron.
  child.ELECTRON_RUN_AS_NODE = '1';
  return child;
}

let adapterExecutablePath: string | null = null;

/** Resolves the pinned local package's entry script. Never npx -- see Global
 *  Constraints. The published package's `bin` field points at a Node ESM
 *  script (`dist/index.js`, shebang `#!/usr/bin/env node`), not a native
 *  binary, so it must be launched with the current Node executable rather
 *  than spawned directly. */
function resolveAdapterExecutable(): string {
  if (adapterExecutablePath) return adapterExecutablePath;
  adapterExecutablePath = require.resolve('@agentclientprotocol/codex-acp/dist/index.js');
  return adapterExecutablePath;
}

const MAX_RETAINED_STDERR_BYTES = 8192;

export function spawnAcpProcess(): ChildProcessWithoutNullStreams {
  const codexHome = resolveCodexHome();
  const env = buildCodexChildEnv(process.env, codexHome);
  const executable = resolveAdapterExecutable();
  const child = spawn(process.execPath, [executable], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env });

  let stderrBuf = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-MAX_RETAINED_STDERR_BYTES);
  });
  (child as ChildProcessWithoutNullStreams & { retainedStderr: () => string }).retainedStderr = () => stderrBuf;

  return child;
}
