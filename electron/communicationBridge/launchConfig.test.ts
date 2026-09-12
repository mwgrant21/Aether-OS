// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { assertBridgePolicy, BRIDGE_ALLOWED_TOOLS, prepareBridgeLaunch, protectLaunchDirectory, cleanupStaleBridgeLaunches, preflightBridgeLaunch } from './launchConfig';
import { spawnPty } from '../ptyManager';

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aether-launch-test-' space-")); directories.push(root);
  const options = { root, helperPath: join(root, 'private-helper.js'), nodePath: process.execPath,
    manifest: { launchId: 'launch-id', endpoint: 'pipe-only-in-manifest', capability: 'CAPABILITY_SENTINEL_01234567890123456789' } };
  const dependencies = { checkPolicy: vi.fn(async () => {}), resolveClaude: vi.fn(async () => process.execPath), protect: protectLaunchDirectory };
  return { root, options, dependencies };
}

describe('bridge policy', () => {
  it('does not replace unrelated global servers', () => {
    expect(() => assertBridgePolicy({ mcpServers: { other: { command: 'keep' } }, permissions: { deny: ['Bash(rm *)'] } })).not.toThrow();
  });
  it.each([{ mcpServers: { 'aether-bridge': {} } }, { managedMcpServers: { 'aether-bridge': {} } }])('rejects name collisions', value => {
    expect(() => assertBridgePolicy(value)).toThrow('SERVER_NAME_COLLISION');
  });
  it.each(['mcp__aether-bridge__*', 'mcp__*', '*', BRIDGE_ALLOWED_TOOLS[0], 'mcp__aether-bridge'])('preserves deny %s', rule => {
    expect(() => assertBridgePolicy({ permissions: { deny: [rule] } })).toThrow('BRIDGE_PERMISSION_DENIED');
  });
  it.each([{ allowManagedPermissionRulesOnly: true }, { allowedMcpServers: [] }, { deniedMcpServers: [] }])('does not override managed policy', value => {
    expect(() => assertBridgePolicy(value)).toThrow('MANAGED_POLICY_REQUIRES_REVIEW');
  });
});

describe.runIf(process.platform === 'win32')('private Windows launch', () => {
  it.runIf(process.env.AETHER_LAUNCH_PREFLIGHT === '1')('checks installed native CLI version and local policy without a model call', async () => {
    const path = await preflightBridgeLaunch({ nodePath: process.execPath, helperPath: join(process.cwd(), 'out/main/communication-mcp.js') });
    expect(path.toLowerCase()).toMatch(/claude\.exe$/);
  });
  it('enforces a current-user-only ACL in real Windows PowerShell', async () => {
    const { root } = await fixture();
    await protectLaunchDirectory(root);
  });
  it('protects the directory before writing secrets and grants only exact session tools', async () => {
    const { options, dependencies } = await fixture();
    dependencies.protect = async directory => {
      expect(await readdir(directory)).toEqual([]);
      await protectLaunchDirectory(directory);
    };
    const launch = await prepareBridgeLaunch({ ...options, sourceEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'billing', CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '321' } }, dependencies);
    const config = JSON.parse(await readFile(join(launch.directory, 'mcp.json'), 'utf8'));
    const parameters = JSON.parse(await readFile(join(launch.directory, 'launch.json'), 'utf8'));
    expect(Object.keys(config.mcpServers)).toEqual(['aether-bridge']);
    expect(config.mcpServers['aether-bridge']).toMatchObject({ alwaysLoad: true, timeout: 90000,
      env: { AETHER_BRIDGE_CAPABILITY: options.manifest.capability } });
    expect(parameters.arguments).toEqual(['--mcp-config', join(launch.directory, 'mcp.json'), '--allowedTools', ...BRIDGE_ALLOWED_TOOLS]);
    expect(parameters).toMatchObject({ hadBackground: true, previousBackground: '321' });
    expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(launch.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS).toBe('120000');
    expect(launch.env.AETHER_BRIDGE_CAPABILITY).toBeUndefined();
    expect(await launch.completion()).toBe('running');
    await launch.cleanup();
    expect(await readdir(options.root)).toEqual([]);
  });
  it('fails without secrets when directory protection fails', async () => {
    const { options, dependencies } = await fixture();
    dependencies.protect = async () => { throw new Error('denied'); };
    await expect(prepareBridgeLaunch(options, dependencies)).rejects.toThrow('LAUNCH_CONFIG_FAILED');
    expect(await readdir(options.root)).toEqual([]);
  });
  it('reports startup failure when a policy-blocked script never produces a process receipt', async () => {
    const { options, dependencies } = await fixture();
    const launch = await prepareBridgeLaunch(options, dependencies);
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 15001);
    try { expect(await launch.completion()).toBe('failed'); }
    finally { clock.mockRestore(); }
  });
  it('refuses a profile-supplied config root before starting Claude and restores the original threshold', async () => {
    const { options, dependencies } = await fixture();
    const launch = await prepareBridgeLaunch({ ...options, sourceEnv: { ...process.env, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '777' } }, dependencies);
    const q = (text: string) => "'" + text.replace(/'/g, "''") + "'";
    const child = spawn('powershell.exe', ['-Command', "$env:CLAUDE_CONFIG_DIR='unsupported-root'; & " + q(launch.scriptPath) + "; Write-Output ('RESTORED=' + $env:CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS)"],
      { env: launch.env, windowsHide: true, stdio: 'pipe' });
    let output = ''; child.stdout.on('data', data => { output += data; });
    await new Promise<void>((done, reject) => { child.once('close', () => done()); child.once('error', reject); });
    expect(await launch.completion()).toBe('failed');
    expect(output).toContain('RESTORED=777');
    expect(await readdir(launch.directory)).not.toContain('started.json');
  });
  it('removes only stale owned bundles and retains live or unknown owners', async () => {
    const { options, dependencies } = await fixture();
    const launch = await prepareBridgeLaunch(options, dependencies);
    const stale = join(options.root, 'launch-stale'); await mkdir(stale);
    await writeFile(join(stale, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
    const unknown = join(options.root, 'launch-unknown'); await mkdir(unknown);
    await cleanupStaleBridgeLaunches(options.root);
    expect(await readdir(options.root)).toEqual(expect.arrayContaining([launch.directory.split(/[\\/]/).at(-1), 'launch-unknown']));
    expect(await readdir(options.root)).not.toContain('launch-stale');
  });
  it.each([undefined, '333'])('real PowerShell restores %s, strips profile billing variables, and observes child exit before shell exit', async previous => {
    const { options, dependencies } = await fixture();
    const sourceEnv = { ...process.env };
    if (previous === undefined) delete sourceEnv.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS;
    else sourceEnv.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = previous;
    const launch = await prepareBridgeLaunch({ ...options, sourceEnv }, dependencies);
    const observedPath = join(options.root, 'observed.json');
    const fakePath = join(options.root, 'fake-cli.cjs');
    await writeFile(fakePath, "require('node:fs').writeFileSync(process.argv[2],JSON.stringify({args:process.argv.slice(3),threshold:process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS,billing:!!process.env.ANTHROPIC_API_KEY,path:process.env.PATH}));");
    const parameters = JSON.parse(await readFile(join(launch.directory, 'launch.json'), 'utf8'));
    parameters.arguments = [fakePath, observedPath, 'quote"and\\tail\\', 'private argument'];
    await writeFile(join(launch.directory, 'launch.json'), JSON.stringify(parameters));
    const profile = join(options.root, 'hostile-profile.ps1');
    await writeFile(profile, "$env:CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS='1'; $env:ANTHROPIC_API_KEY='PROFILE_BILLING_SECRET'; $env:PATH=$env:PATH+';profile-path-sentinel'");
    const q = (text: string) => "'" + text.replace(/'/g, "''") + "'";
    const child = spawn('powershell.exe', ['-NoExit', '-Command', '& ' + q(profile) + '; & ' + q(launch.scriptPath)],
      { env: launch.env, windowsHide: true, stdio: 'pipe' });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    try {
      await vi.waitFor(async () => { expect(await launch.completion()).toBe('exited'); }, { timeout: 15000, interval: 50 });
      expect(child.exitCode).toBeNull();
      const observed = JSON.parse(await readFile(observedPath, 'utf8'));
      expect(observed).toMatchObject({ threshold: '120000', billing: false, args: ['quote"and\\tail\\', 'private argument'] });
      expect(observed.path).toContain('profile-path-sentinel');
      child.stdin.write("Write-Output ('RESTORED=' + $env:CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS)\r\nGet-History | ConvertTo-Json -Compress\r\nexit\r\n");
      await new Promise<void>((done, reject) => { child.once('close', () => done()); child.once('error', reject); });
      expect(output).toContain('RESTORED=' + (previous ?? ''));
      expect(output).not.toContain(options.manifest.capability);
      expect(output).not.toContain('PROFILE_BILLING_SECRET');
      expect(output).not.toContain('private argument');
    } finally { if (child.exitCode === null) child.kill(); }
  }, 25000);
  it('real ConPTY routes stdin to native child and retains the shell after its exit without echoed manifest content', async () => {
    const { options, dependencies } = await fixture();
    const launch = await prepareBridgeLaunch(options, dependencies);
    const observedPath = join(options.root, 'stdin.json');
    const fakePath = join(options.root, 'interactive-cli.cjs');
    await writeFile(fakePath, "process.stdin.setRawMode(true);process.stdout.write('NATIVE_READY');process.stdin.once('data',d=>{require('node:fs').writeFileSync(process.argv[2],JSON.stringify({input:d.toString(),tty:process.stdin.isTTY,threshold:process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS}));process.exit(0)});");
    const parameters = JSON.parse(await readFile(join(launch.directory, 'launch.json'), 'utf8'));
    parameters.arguments = [fakePath, observedPath];
    await writeFile(join(launch.directory, 'launch.json'), JSON.stringify(parameters));
    const terminal = spawnPty(100, 30, launch);
    let output = '', exited = false;
    terminal.onData(data => { output += data; }); terminal.onExit(() => { exited = true; });
    try {
      await vi.waitFor(() => expect(output).toContain('NATIVE_READY'), { timeout: 15000, interval: 50 });
      terminal.write('x');
      await vi.waitFor(async () => expect(await launch.completion()).toBe('exited'), { timeout: 5000, interval: 50 });
      expect(exited).toBe(false);
      expect(JSON.parse(await readFile(observedPath, 'utf8'))).toEqual({ input: 'x', tty: true, threshold: '120000' });
      terminal.write("Get-History | ConvertTo-Json -Compress\r");
      terminal.write("Write-Output 'HISTORY_CHECK_DONE'\r");
      await vi.waitFor(() => expect(output).toContain('HISTORY_CHECK_DONE'), { timeout: 5000, interval: 50 });
      expect(output).not.toContain(options.manifest.capability);
      expect(output).not.toContain(options.helperPath);
      expect(output).not.toContain('AETHER_BRIDGE_CAPABILITY');
      terminal.write('exit\r');
      await vi.waitFor(() => expect(exited).toBe(true), { timeout: 5000, interval: 50 });
    } finally { if (!exited) terminal.kill(); }
  }, 30000);
});
