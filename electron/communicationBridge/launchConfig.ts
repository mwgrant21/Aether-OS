import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, lstat, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { CommunicationLaunchManifest } from './mainIntegration';
import { buildPtyEnv, type BridgePtyLaunch } from '../ptyManager';

const run = promisify(execFile);
export const BRIDGE_ALLOWED_TOOLS = ['ask_codex', 'get_codex_exchange', 'cancel_codex_exchange']
  .map(name => 'mcp__aether-bridge__' + name);
export const BRIDGE_CLAUDE_VERSION = '2.1.269';
const BACKGROUND = 'CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS';
const powershell = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const psQuote = (value: string) => "'" + value.replace(/'/g, "''") + "'";

export interface PreparedBridgeLaunch extends BridgePtyLaunch {
  directory: string;
  completion(): Promise<'unknown' | 'starting' | 'running' | 'exited' | 'failed'>;
  cleanup(): Promise<void>;
}
export interface LaunchConfigOptions {
  manifest: CommunicationLaunchManifest;
  root: string;
  helperPath: string;
  nodePath: string;
  sourceEnv?: NodeJS.ProcessEnv;
  executable?: string;
}
interface LaunchDependencies {
  resolveClaude(): Promise<string>;
  checkPolicy(env: NodeJS.ProcessEnv): Promise<void>;
  protect(directory: string): Promise<void>;
  remove?(directory: string): Promise<void>;
}

async function jsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const bytes = await readFile(path);
    if (bytes.length > 2 * 1024 * 1024) throw new Error('CONFIG_UNREADABLE');
    const value: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONFIG_UNREADABLE');
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('CONFIG_UNREADABLE');
  }
}

/** Conservative local preflight. Claude remains authoritative for remote policy. */
export function assertBridgePolicy(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const config = value as Record<string, unknown>;
  for (const key of ['mcpServers', 'managedMcpServers']) {
    const servers = config[key];
    if (servers && typeof servers === 'object' && Object.hasOwn(servers, 'aether-bridge')) throw new Error('SERVER_NAME_COLLISION');
  }
  if (config.allowManagedPermissionRulesOnly === true || config.allowedMcpServers !== undefined || config.deniedMcpServers !== undefined) {
    throw new Error('MANAGED_POLICY_REQUIRES_REVIEW');
  }
  const permissions = config.permissions as { deny?: unknown } | undefined;
  if (permissions?.deny !== undefined) {
    if (!Array.isArray(permissions.deny)) throw new Error('CONFIG_UNREADABLE');
    for (const rule of permissions.deny) {
      if (typeof rule !== 'string') throw new Error('CONFIG_UNREADABLE');
      const escaped = rule.split('*').map(part => part.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')).join('.*');
      if (BRIDGE_ALLOWED_TOOLS.some(name => new RegExp('^' + escaped + '$').test(name)) || rule === 'mcp__aether-bridge') {
        throw new Error('BRIDGE_PERMISSION_DENIED');
      }
    }
  }
}

async function checkPolicy(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.CLAUDE_CONFIG_DIR) throw new Error('CUSTOM_CONFIG_UNSUPPORTED');
  const home = homedir();
  const user = await jsonFile(join(home, '.claude.json'));
  assertBridgePolicy(user);
  const projects = user?.projects;
  if (projects && typeof projects === 'object') {
    for (const [path, config] of Object.entries(projects)) {
      if (resolve(path).toLowerCase() === resolve(home).toLowerCase()) assertBridgePolicy(config);
    }
  }
  const managed = join(env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode');
  if (await jsonFile(join(managed, 'managed-mcp.json'))) throw new Error('MANAGED_MCP_EXCLUSIVE');
  for (const path of [join(home, '.claude/settings.json'), join(home, '.claude/settings.local.json'),
    join(home, '.mcp.json'), join(managed, 'managed-settings.json')]) assertBridgePolicy(await jsonFile(path));
  const { stdout } = await run(powershell(), ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; foreach($k in @('HKLM:\\SOFTWARE\\Policies\\ClaudeCode','HKCU:\\SOFTWARE\\Policies\\ClaudeCode')) { if(Test-Path -LiteralPath $k) { $v=Get-ItemProperty -LiteralPath $k; if($v.Settings) { Write-Output $v.Settings } } }"],
  { windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
  if (stdout.trim()) throw new Error('MANAGED_POLICY_REQUIRES_REVIEW');
}

async function resolveClaude(): Promise<string> {
  const { stdout } = await run(powershell(), ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; (Get-Command claude -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source"],
  { windowsHide: true, timeout: 10_000 });
  const executable = stdout.trim();
  if (!executable.toLowerCase().endsWith('.exe')) throw new Error('NATIVE_CLAUDE_REQUIRED');
  const version = await run(executable, ['--version'], { env: buildPtyEnv(), windowsHide: true, timeout: 10_000 });
  if (!new RegExp('^' + BRIDGE_CLAUDE_VERSION.replace(/\./g, '\\.') + '\\s').test(version.stdout.trim())) throw new Error('CLAUDE_VERSION_REPROBE_REQUIRED');
  return executable;
}

export async function protectLaunchDirectory(directory: string): Promise<void> {
  const script = "$ErrorActionPreference='Stop'; $p=" + psQuote(directory) + "; " +
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; " +
    "$acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); " +
    "$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); " +
    "$acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($p,$acl); " +
    "$actual=[IO.Directory]::GetAccessControl($p); if(!$actual.AreAccessRulesProtected){throw 'ACL'}; " +
    "foreach($r in $actual.Access){if($r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $r.AccessControlType -ne 'Allow'){throw 'ACL'}}";
  await run(powershell(), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000 });
}

export const BRIDGE_LAUNCH_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$aetherLaunch=$null',
  '$aetherChild=$null',
  'try {',
  "  $aetherLaunch=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'launch.json') -Raw | ConvertFrom-Json",
  "  if($env:CLAUDE_CONFIG_DIR){throw 'Connected launch cannot use a profile-provided config root'}",
  '  # Profiles have already run. Reapply the client-wide pin after them, preserving PATH.',
  '  Remove-Item Env:\\ANTHROPIC_API_KEY,Env:\\ANTHROPIC_AUTH_TOKEN,Env:\\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue',
  "  $env:CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS='120000'",
  '  $aetherArgs=@($aetherLaunch.arguments | ForEach-Object { \'"\' + ([string]$_ -replace \'(\\\\*)"\', \'$1$1\\"\' -replace \'(\\\\+)$\', \'$1$1\') + \'"\' })',
  '  $aetherChild=Start-Process -FilePath $aetherLaunch.executable -ArgumentList ($aetherArgs -join \' \') -WorkingDirectory $aetherLaunch.workingDirectory -NoNewWindow -PassThru',
  "  @{pid=$aetherChild.Id} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'started.json')",
  '  $aetherChild.WaitForExit()',
  '} catch {',
  "  Write-Warning 'Connected Claude launch failed or was interrupted. Check Aether communication status.'",
  '} finally {',
  '  if($null -ne $aetherLaunch) {',
  '    if($aetherLaunch.hadBackground){$env:CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=[string]$aetherLaunch.previousBackground}',
  '    else {Remove-Item Env:\\CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS -ErrorAction SilentlyContinue}',
  '  } else {Remove-Item Env:\\CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS -ErrorAction SilentlyContinue}',
  '  # An interrupted WaitForExit is not proof. Main also observes the native PID.',
  "  if($null -eq $aetherChild){'failed' | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'completed')}",
  "  elseif($aetherChild.HasExited){'exited' | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'completed')}",
  "  else {'failed' | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'completed')}",
  '}',
].join('\r\n');

export async function preflightBridgeLaunch(options: Pick<LaunchConfigOptions, 'helperPath' | 'nodePath' | 'sourceEnv'>): Promise<string> {
  if (process.platform !== 'win32') throw new Error('BRIDGE_LAUNCH_PLATFORM_UNSUPPORTED');
  for (const path of [options.helperPath, options.nodePath]) if (!(await lstat(path)).isFile()) throw new Error('LAUNCH_RUNTIME_MISSING');
  await checkPolicy(options.sourceEnv ?? process.env);
  return resolveClaude();
}

export async function prepareBridgeLaunch(options: LaunchConfigOptions,
  dependencies: LaunchDependencies = { resolveClaude, checkPolicy, protect: protectLaunchDirectory }): Promise<PreparedBridgeLaunch> {
  if (process.platform !== 'win32') throw new Error('BRIDGE_LAUNCH_PLATFORM_UNSUPPORTED');
  const source = options.sourceEnv ?? process.env;
  await dependencies.checkPolicy(source);
  const executable = options.executable ?? await dependencies.resolveClaude();
  const root = resolve(options.root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('UNSAFE_LAUNCH_ROOT');
  const directory = await mkdtemp(join(root, 'launch-'));
  const remove = dependencies.remove ?? ((path: string) => rm(path, { recursive: true, force: true }));
  try {
    await dependencies.protect(directory); // No capability exists on disk before this succeeds.
    await writeFile(join(directory, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' });
    const configPath = join(directory, 'mcp.json');
    await writeFile(configPath, JSON.stringify({ mcpServers: { 'aether-bridge': {
      type: 'stdio', command: options.nodePath, args: [options.helperPath], alwaysLoad: true, timeout: 90_000,
      env: { ELECTRON_RUN_AS_NODE: '1', AETHER_BRIDGE_PIPE: options.manifest.endpoint, AETHER_BRIDGE_CAPABILITY: options.manifest.capability },
    } } }), { mode: 0o600, flag: 'wx' });
    await writeFile(join(directory, 'launch.json'), JSON.stringify({ executable, workingDirectory: homedir(),
      arguments: ['--mcp-config', configPath, '--allowedTools', ...BRIDGE_ALLOWED_TOOLS],
      hadBackground: source[BACKGROUND] !== undefined, previousBackground: source[BACKGROUND] ?? '',
    }), { mode: 0o600, flag: 'wx' });
    const scriptPath = join(directory, 'launch.ps1');
    await writeFile(scriptPath, BRIDGE_LAUNCH_SCRIPT, { mode: 0o600, flag: 'wx' });
    const env = { ...buildPtyEnv(source), [BACKGROUND]: '120000' };
    const preparedAt = Date.now();
    let observedPid: number | undefined;
    let cleaned = false;
    return { directory, scriptPath, env,
      completion: async () => {
        try {
          if (cleaned) throw Object.assign(new Error('removed'), { code: 'ENOENT' });
          const receipt = (await readFile(join(directory, 'completed'), 'utf8')).trim();
          return receipt === 'exited' ? 'exited' : 'failed';
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('LAUNCH_STATUS_UNREADABLE'); }
        const started = cleaned ? undefined : await jsonFile(join(directory, 'started.json'));
        if (typeof started?.pid === 'number' && Number.isInteger(started.pid) && started.pid > 0) {
          observedPid = started.pid;
        }
        if (observedPid !== undefined) {
          try { process.kill(observedPid, 0); return 'running'; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'exited';
            throw new Error('LAUNCH_STATUS_UNREADABLE');
          }
        }
        if (started) return 'failed';
        return cleaned ? 'unknown' : Date.now() - preparedAt > 15_000 ? 'failed' : 'starting';
      },
      cleanup: async () => { await remove(directory); cleaned = true; },
    };
  } catch {
    try { await remove(directory); }
    catch { throw new Error('LAUNCH_CONFIG_CLEANUP_FAILED'); }
    throw new Error('LAUNCH_CONFIG_FAILED');
  }
}

/** Never age-delete another live app's launch artifacts. A reused PID is kept. */
export async function cleanupStaleBridgeLaunches(inputRoot: string): Promise<void> {
  const root = resolve(inputRoot);
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if ((await lstat(root)).isSymbolicLink()) throw new Error('UNSAFE_LAUNCH_ROOT');
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^launch-[A-Za-z0-9]+$/.test(entry.name)) continue;
    const directory = join(root, entry.name);
    if (dirname(directory) !== root) throw new Error('UNSAFE_LAUNCH_ROOT');
    const owner = await jsonFile(join(directory, 'owner.json'));
    if (!Number.isInteger(owner?.pid) || (owner!.pid as number) <= 0) continue;
    try { process.kill(owner!.pid as number, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') await rm(directory, { recursive: true, force: true }); }
  }
}
