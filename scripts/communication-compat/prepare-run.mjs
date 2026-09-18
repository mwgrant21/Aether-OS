// Creates a FRESH run directory and the client config for one compatibility
// probe. Never writes into an existing run: the 2.1.270 evidence was nearly
// lost to an auditor that wrote back into its own source directory, so every
// run here gets its own timestamped folder and refuses to reuse one.
//
// Run directories live OUTSIDE the repository by default. They contain a real
// client transcript path, a session id, a debug log and machine-specific
// paths; none of that belongs in git.
//
//   node prepare-run.mjs [--client <path>] [--expect-version <prefix>]
//                        [--run-root <dir>] [--workspace <dir>]
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { trustWorkspace } from './trust-workspace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function resolveClient() {
  // Always absolute. run-probe.ps1 does Set-Location into the workspace before
  // invoking this path, so a relative --client that worked here would simply
  // not be found there -- and only at the model-bearing step.
  const explicit = arg('client');
  if (explicit) return resolve(explicit);
  // Mirror production's resolution (launchConfig.ts resolveClaude): the native
  // .exe as found on PATH, not a shell shim.
  const out = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
     "$ErrorActionPreference='Stop'; (Get-Command claude -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source"],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim();
  if (!out.toLowerCase().endsWith('.exe')) throw new Error(`NATIVE_CLAUDE_REQUIRED: resolved ${out}`);
  return out;
}

const client = resolve(resolveClient());
const versionOutput = execFileSync(client, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim();
const expect = arg('expect-version');
if (expect && !(versionOutput.startsWith(expect) && /\s/.test(versionOutput.slice(expect.length, expect.length + 1)))) {
  throw new Error(`VERSION_MISMATCH: wanted ${expect}, client reports ${versionOutput}`);
}

const runRoot = resolve(arg('run-root', join(process.env.LOCALAPPDATA ?? tmpdir(), 'aether-communication-compat', 'runs')));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = join(runRoot, stamp);
if (existsSync(runDir)) throw new Error(`RUN_DIR_EXISTS: ${runDir}`);
mkdirSync(runDir, { recursive: true });

// The client's cwd during the probe. Kept separate from the run directory so
// the transcript lands in a predictable project folder.
const workspace = resolve(arg('workspace', join(runDir, 'workspace')));
mkdirSync(workspace, { recursive: true });

const nodePath = process.execPath;
const serverPath = join(HERE, 'fake-bridge-server.mjs');
const MCP_TIMEOUT_MS = 90_000;

// The same shape launchConfig.ts writes, minus the per-launch pipe/capability
// (there is no Aether instance here). Divergences from production are the
// thing this harness exists to avoid, so they are listed in the README.
writeFileSync(join(runDir, 'mcp.json'), JSON.stringify({
  mcpServers: {
    'aether-bridge': {
      type: 'stdio',
      command: nodePath,
      args: [serverPath],
      alwaysLoad: true,
      timeout: MCP_TIMEOUT_MS,
      env: { AETHER_COMPAT_RUN_DIR: runDir, AETHER_COMPAT_MCP_TIMEOUT_MS: String(MCP_TIMEOUT_MS) },
    },
  },
}, null, 2) + '\n');

const sessionId = randomUUID();
writeFileSync(join(runDir, 'session.json'), JSON.stringify({
  session_id: sessionId,
  client,
  version: versionOutput,
  cwd: workspace.replace(/\\/g, '/'),
  // Production does NOT pass --permission-mode; the 2.1.270 probe did (manual),
  // which meant it validated a launch shape production never uses. Default here
  // is production's: no mode flag, preapproval carried entirely by --allowedTools.
  requested_permission_mode: arg('permission-mode', null),
  mcp_timeout_ms: MCP_TIMEOUT_MS,
  background_ms: '120000',
  fake_call_budget: 3,
  real_codex_calls: 0,
  run_dir: runDir,
  transcript_hint: join(homedir(), '.claude', 'projects',
    workspace.replace(/\\/g, '/').replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`),
}, null, 2) + '\n');

// A fresh workspace means a fresh folder-trust dialog, and the client stops on
// it before it ever reaches the MCP server -- which looks exactly like a harness
// failure. Pre-accept it for this scratch directory only; see trust-workspace.mjs
// for the backup/verify discipline around writing the operator's config.
const trust = trustWorkspace(workspace);
if (!trust.trusted) {
  console.error(`WARNING: could not pre-accept the trust dialog (${trust.reason}).`);
  console.error('The probe will stop on a trust screen; accept it in the console window.');
}

console.log(JSON.stringify({ run_dir: runDir, workspace, session_id: sessionId, client, version: versionOutput,
  workspace_pre_trusted: trust.trusted, config_backup: trust.backup ?? null }, null, 2));
