// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { assertBridgePolicy, BRIDGE_ALLOWED_TOOLS, BRIDGE_CLAUDE_VERSION, prepareBridgeLaunch, protectLaunchDirectory, cleanupStaleBridgeLaunches, preflightBridgeLaunch } from './launchConfig';
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

it('keeps the native connected fixture version aligned with production', async () => {
  const source = await readFile(join(process.cwd(), 'e2e/fixtures/connected-client.cs'), 'utf8');
  const version = source.match(/Console\.WriteLine\("(\d+\.\d+\.\d+) \(Aether harmless native fixture\)"\)/)?.[1];
  expect(version).toBe(BRIDGE_CLAUDE_VERSION);
});

describe.runIf(process.platform === 'win32')('private Windows launch', () => {
  it('retains only observed PID evidence after receipt cleanup and distinguishes read failure', async () => {
    const { options, dependencies } = await fixture();
    // Time the existing protection call; do not warm PowerShell with an extra call.
    const protect = dependencies.protect;
    dependencies.protect = async directory => {
      const started = process.hrtime.bigint();
      let outcome = 'rejected';
      try {
        await protect(directory);
        outcome = 'resolved';
      } finally {
        try {
          console.error('[launch-protection]', JSON.stringify({ event: 'protect-directory',
            elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000, outcome }));
        } catch { /* Diagnostics must not replace the protection result. */ }
      }
    };
    const launch = await prepareBridgeLaunch(options, dependencies);
    await writeFile(join(launch.directory, 'started.json'), JSON.stringify({ pid: process.pid }));
    expect(await launch.completion()).toBe('running');
    await launch.cleanup();
    expect(await readdir(options.root)).toEqual([]);
    expect(await launch.completion()).toBe('running');
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    try {
      await expect(launch.completion()).rejects.toThrow('LAUNCH_STATUS_UNREADABLE');
      probe.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
      expect(await launch.completion()).toBe('exited');
    } finally { probe.mockRestore(); }
  }, 40_000);
  it('does not infer exit or running from absent or malformed startup evidence', async () => {
    const { options, dependencies } = await fixture();
    const launch = await prepareBridgeLaunch(options, dependencies);
    expect(await launch.completion()).toBe('starting');
    await writeFile(join(launch.directory, 'started.json'), JSON.stringify({ pid: 'secret' }));
    expect(await launch.completion()).toBe('failed');
    await launch.cleanup();
    expect(await launch.completion()).toBe('unknown');
  }, 40_000);
  it.runIf(process.env.AETHER_LAUNCH_PREFLIGHT === '1')('checks installed native CLI version and local policy without a model call', async () => {
    const path = await preflightBridgeLaunch({ nodePath: process.execPath, helperPath: join(process.cwd(), 'out/main/communication-mcp.js') });
    expect(path.toLowerCase()).toMatch(/claude\.exe$/);
  }, 80_000);
  it('enforces a current-user-only ACL in real Windows PowerShell', async () => {
    const { root } = await fixture();
    await protectLaunchDirectory(root);
  }, 40_000);
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
    expect(await launch.completion()).toBe('starting');
    await launch.cleanup();
    expect(await readdir(options.root)).toEqual([]);
  }, 40_000);
  it('fails without secrets when directory protection fails', async () => {
    const { options, dependencies } = await fixture();
    dependencies.protect = async () => { throw new Error('denied'); };
    await expect(prepareBridgeLaunch(options, dependencies)).rejects.toThrow('LAUNCH_CONFIG_FAILED');
    expect(await readdir(options.root)).toEqual([]);
  });
  it('distinguishes retained launch files when partial preparation cleanup also fails', async () => {
    const { options, dependencies } = await fixture();
    const broken = { ...dependencies,
      protect: async (directory: string) => {
        await protectLaunchDirectory(directory);
        await writeFile(join(directory, 'partial-manifest'), options.manifest.capability);
        throw new Error('simulated preparation failure');
      },
      remove: async () => { throw new Error('simulated removal failure'); },
    };
    await expect(prepareBridgeLaunch(options, broken)).rejects.toThrow('LAUNCH_CONFIG_CLEANUP_FAILED');
    const entries = await readdir(options.root);
    expect(entries).toHaveLength(1);
    expect(await readFile(join(options.root, entries[0], 'partial-manifest'), 'utf8')).toBe(options.manifest.capability);
  }, 40_000);
  it('reports startup failure when no native process receipt arrives by the deadline', async () => {
    const { options, dependencies } = await fixture();
    const launch = await prepareBridgeLaunch(options, dependencies);
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 15001);
    try { expect(await launch.completion()).toBe('failed'); }
    finally { clock.mockRestore(); }
  }, 40_000);
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
  }, 40_000);
  it('removes only stale owned bundles and retains live or unknown owners', async () => {
    const { options, dependencies } = await fixture();
    const launch = await prepareBridgeLaunch(options, dependencies);
    const stale = join(options.root, 'launch-stale'); await mkdir(stale);
    await writeFile(join(stale, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
    const unknown = join(options.root, 'launch-unknown'); await mkdir(unknown);
    await cleanupStaleBridgeLaunches(options.root);
    expect(await readdir(options.root)).toEqual(expect.arrayContaining([launch.directory.split(/[\\/]/).at(-1), 'launch-unknown']));
    expect(await readdir(options.root)).not.toContain('launch-stale');
  }, 40_000);
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
  }, 45_000);
  it.each(['absent-profile', 'failed-profile', 'native-launch-failure'])('real PowerShell reports the observed outcome for %s', async scenario => {
    const { options, dependencies } = await fixture();
    const launch = await prepareBridgeLaunch({ ...options, sourceEnv: { ...process.env, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '901' } }, dependencies);
    const observed = join(options.root, 'observed.json');
    const fake = join(options.root, 'fake-cli.cjs');
    await writeFile(fake, "require('node:fs').writeFileSync(process.argv[2],JSON.stringify({threshold:process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS,billing:!!process.env.ANTHROPIC_API_KEY}));");
    const parameters = JSON.parse(await readFile(join(launch.directory, 'launch.json'), 'utf8'));
    parameters.arguments = [fake, observed];
    if (scenario === 'native-launch-failure') parameters.executable = join(options.root, 'does-not-exist.exe');
    await writeFile(join(launch.directory, 'launch.json'), JSON.stringify(parameters));
    const q = (value: string) => "'" + value.replace(/'/g, "''") + "'";
    let prefix = '';
    if (scenario === 'failed-profile') {
      const profile = join(options.root, 'failed-profile.ps1');
      await writeFile(profile, "$env:CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS='2'; $env:ANTHROPIC_API_KEY='PROFILE_SENTINEL'; throw 'deliberate profile failure'");
      prefix = '& ' + q(profile) + '; ';
    }
    // NoProfile deliberately establishes the absent-profile baseline only in this test.
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', prefix + '& ' + q(launch.scriptPath) + "; Write-Output ('RESTORED=' + $env:CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS)"],
      { env: launch.env, windowsHide: true, stdio: 'pipe' });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    await new Promise<void>((done, reject) => { child.once('close', () => done()); child.once('error', reject); });
    if (scenario === 'failed-profile') {
      expect(child.exitCode).not.toBeNull();
      expect(await readdir(launch.directory)).not.toContain('started.json');
      // A terminating profile can prevent -File from running at all. Main's shell-exit
      // event revokes earlier; this fallback must still become failed, never ready.
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15001);
      try { expect(await launch.completion()).toBe('failed'); }
      finally { clock.mockRestore(); }
      return;
    }
    expect(await launch.completion()).toBe(scenario === 'native-launch-failure' ? 'failed' : 'exited');
    expect(output).toContain('RESTORED=901');
    if (scenario !== 'native-launch-failure') expect(JSON.parse(await readFile(observed, 'utf8'))).toEqual({ threshold: '120000', billing: false });
  }, 35_000);
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
  }, 50_000);
  it('real ConPTY Ctrl+C interrupts the native child, restores the threshold, and keeps the shell usable', async () => {
    const { options, dependencies } = await fixture();
    const launch = await prepareBridgeLaunch({ ...options, sourceEnv: { ...process.env, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '902' } }, dependencies);
    const fake = join(options.root, 'interruptible-cli.cjs');
    await writeFile(fake, "process.on('SIGINT',()=>process.exit(130));process.stdin.resume();console.log('INTERRUPT_READY');");
    const parameters = JSON.parse(await readFile(join(launch.directory, 'launch.json'), 'utf8'));
    parameters.arguments = [fake];
    await writeFile(join(launch.directory, 'launch.json'), JSON.stringify(parameters));
    const terminal = spawnPty(100, 30, launch);
    let output = '', exited = false, nativePid: number | undefined;
    terminal.onData(data => { output += data; }); terminal.onExit(() => { exited = true; });
    try {
      await vi.waitFor(() => expect(output).toContain('INTERRUPT_READY'), { timeout: 15000, interval: 50 });
      await vi.waitFor(async () => expect(await launch.completion()).toBe('running'), { timeout: 5000, interval: 50 });
      nativePid = JSON.parse(await readFile(join(launch.directory, 'started.json'), 'utf8')).pid;
      terminal.write('\x03');
      await vi.waitFor(async () => expect(await launch.completion()).not.toBe('running'), { timeout: 5000, interval: 50 });
      await vi.waitFor(() => expect(() => process.kill(nativePid!, 0)).toThrow(), { timeout: 5000, interval: 50 });
      expect(exited).toBe(false);
      terminal.write("Write-Output ('INTERRUPT_RESTORED=' + $env:CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS)\r");
      await vi.waitFor(() => expect(output).toContain('INTERRUPT_RESTORED=902'), { timeout: 5000, interval: 50 });
      expect(output).not.toContain(options.manifest.capability);
      terminal.write('exit\r');
      await vi.waitFor(() => expect(exited).toBe(true), { timeout: 5000, interval: 50 });
    } finally {
      if (!exited) terminal.kill();
      if (nativePid) { try { process.kill(nativePid); } catch { /* already confirmed gone */ } }
    }
  }, 50_000);
});

describe.runIf(process.platform === 'win32')('atomic Windows launch receipts', () => {
  const q = (value: string) => "'" + value.replace(/'/g, "''") + "'";
  async function runScript(script: string, directory: string, privateValues: string[]) {
    const path = join(directory, 'receipt-test.ps1');
    await writeFile(path, script);
    const started = Date.now();
    const safe = (text: string) => privateValues.flatMap(value => [value, value.replace(/'/g, "''")])
      .reduce((output, value) => output.split(value).join('[private]'), text).slice(-4096);
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path], {
      windowsHide: true, stdio: 'pipe', timeout: 20000,
    });
    let stdout = '', stderr = '';
    // Keep padding so truncation cannot expose the tail of a redacted fixture value.
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-8192); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
    const state = { spawned: false, exited: false, closed: false, code: null as number | null,
      signal: null as string | null, error: null as string | null };
    child.once('spawn', () => { state.spawned = true; });
    child.once('exit', (code, signal) => { Object.assign(state, { exited: true, code, signal }); });
    let processError: Error | undefined;
    const closed = new Promise<number | null>((done, reject) => {
      child.once('close', (code, signal) => {
        Object.assign(state, { closed: true, code, signal });
        if (processError) reject(processError); else done(code);
      });
      child.once('error', error => { processError = error; state.error = safe(error.message); });
    });
    void closed.catch(() => {}); // Retain rejection for its caller without an early unhandled rejection.
    return { child, closed, safe, output: () => safe(stdout + stderr),
      snapshot: () => ({ elapsedMs: Date.now() - started, ...state, stdout: safe(stdout), stderr: safe(stderr) }) };
  }

  it.each(['atomic', 'direct-write negative control'])('keeps incomplete bytes invisible: %s', async mode => {
    const { options, dependencies } = await fixture();
    const launch = await prepareBridgeLaunch(options, dependencies);
    let script = await readFile(launch.scriptPath, 'utf8');
    if (mode !== 'atomic') {
      // Scratch-only negative control recreates the old direct-final writer.
      script = script.replace('Set-Content -LiteralPath $temporary -Value $Content', 'Set-Content -LiteralPath $final -Value $Content')
        .replace('[IO.File]::Move($temporary, $final)', '');
      await writeFile(launch.scriptPath, script);
    }
    const runner = await runScript(String.raw`
$ErrorActionPreference='Stop'
Remove-Item Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
function Start-Process {
  $fake=[pscustomobject]@{Id=${process.pid};HasExited=$true}
  $fake | Add-Member ScriptMethod WaitForExit {}
  return $fake
}
function Set-Content {
  param([string]$LiteralPath, [string]$Value)
  $name=if([IO.Path]::GetFileName($LiteralPath).StartsWith('started.json')){'started'}else{'completed'}
  [IO.File]::WriteAllText($LiteralPath, $(if($name -eq 'started'){'{"pid":'}else{'ex'}))
  [IO.File]::WriteAllText((Join-Path ${q(options.root)} ($name+'.paused')), $LiteralPath)
  $deadline=[DateTime]::UtcNow.AddSeconds(10)
  while(!(Test-Path -LiteralPath (Join-Path ${q(options.root)} ($name+'.release')))) {
    if([DateTime]::UtcNow -gt $deadline){throw 'receipt test gate timed out'}
    Start-Sleep -Milliseconds 20
  }
  Microsoft.PowerShell.Management\Set-Content -LiteralPath $LiteralPath -Value $Value
  [IO.File]::WriteAllText((Join-Path ${q(options.root)} ($name+'.written')), 'written')
}
& ${q(launch.scriptPath)}
`, options.root, [options.root, options.manifest.capability]);
    let gate = 'started', phase = 'waiting for pause', partialPath: string | undefined;
    const failures: unknown[] = [];
    const message = (error: unknown) => runner.safe(error instanceof Error ? error.message : String(error));
    const diagnose = async (stage: string) => {
      try {
        const paths = { started: join(launch.directory, 'started.json'), completed: join(launch.directory, 'completed'),
          paused: join(options.root, gate + '.paused'), written: join(options.root, gate + '.written'), startedRelease: join(options.root, 'started.release'),
          completedRelease: join(options.root, 'completed.release'), ...(partialPath ? { partial: partialPath } : {}) };
        const receipts = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => {
          try { return [name, { state: 'read', text: runner.safe((await readFile(path)).subarray(0, 512).toString('utf8')) }]; }
          catch (error) { return [name, { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'read-error',
            code: (error as NodeJS.ErrnoException).code ?? null, error: message(error) }]; }
        })));
        console.error('[atomic-receipt]', JSON.stringify({ mode, stage, gate, phase, process: runner.snapshot(), receipts,
          failures: failures.map(message) }));
      } catch (error) {
        failures.push(error);
        // Logging failures must not replace the assertion or prevent cleanup.
      }
    };
    try {
      for (const name of ['started', 'completed']) {
        gate = name; phase = 'waiting for pause'; partialPath = undefined;
        const marker = join(options.root, name + '.paused');
        await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBeTruthy(), { timeout: 10000, interval: 20 });
        partialPath = await readFile(marker, 'utf8'); phase = 'checking partial receipt';
        expect(await readFile(partialPath, 'utf8')).toBe(name === 'started' ? '{"pid":' : 'ex');
        if (mode === 'atomic') {
          expect(partialPath).toMatch(/\.[a-f0-9]{32}\.tmp$/);
          await expect(readFile(join(launch.directory, name === 'started' ? 'started.json' : 'completed'))).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await launch.completion()).toBe(name === 'started' ? 'starting' : 'running');
        } else if (name === 'started') {
          await expect(launch.completion()).rejects.toThrow('CONFIG_UNREADABLE');
        } else {
          expect(await launch.completion()).toBe('failed');
        }
        phase = 'releasing gate';
        await writeFile(join(options.root, name + '.release'), 'release');
        phase = 'waiting for receipt write';
        // completion() opens the receipt to read it and PowerShell's Set-Content opens it
        // with no sharing, so polling across the write makes each side fail the other
        // ("being used by another process" / EBUSY) and leaves the receipt partial for
        // good. Wait on a separate marker the gate drops once its write has returned.
        await vi.waitFor(async () => expect(await readFile(join(options.root, name + '.written'), 'utf8')).toBeTruthy(), { timeout: 10000, interval: 20 });
        phase = 'waiting for completion';
        await vi.waitFor(async () => expect(await launch.completion()).toBe(name === 'started' ? (mode === 'atomic' ? 'running' : 'failed') : 'exited'), { timeout: 10000, interval: 20 });
      }
      phase = 'checking process close';
      expect(await runner.closed, runner.output()).toBe(0);
      phase = 'checking final receipts';
      expect(JSON.parse(await readFile(join(launch.directory, 'started.json'), 'utf8'))).toEqual({ pid: process.pid });
      expect((await readFile(join(launch.directory, 'completed'), 'utf8')).trim()).toBe('exited');
    } catch (error) {
      failures.push(error); await diagnose('before cleanup');
    } finally {
      const releases = await Promise.allSettled(['started', 'completed'].map(name => writeFile(join(options.root, name + '.release'), 'release')));
      for (const result of releases) if (result.status === 'rejected') failures.push(result.reason);
      try { await runner.closed; } catch (error) { failures.push(error); }
      if (failures.length) await diagnose('after cleanup');
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, failures.map(message).join('\n'));
  }, 50_000);

  it.each(['started.json', 'completed'])('does not overwrite an existing %s', async name => {
    const { options, dependencies } = await fixture();
    const launch = await prepareBridgeLaunch(options, dependencies);
    const source = await readFile(launch.scriptPath, 'utf8');
    const helper = source.slice(0, source.indexOf('$aetherLaunch=$null'));
    expect(helper).toContain('[IO.File]::Move($temporary, $final)');
    await writeFile(join(launch.directory, name), 'existing final');
    const runner = await runScript(helper + `\nPublish-AetherReceipt ${q(name)} 'replacement'`, launch.directory, [options.root, options.manifest.capability]);
    expect(await runner.closed).not.toBe(0);
    expect(await readFile(join(launch.directory, name), 'utf8')).toBe('existing final');
    const siblings = (await readdir(launch.directory)).filter(entry => entry.startsWith(name + '.') && entry.endsWith('.tmp'));
    expect(siblings).toHaveLength(1);
    expect((await readFile(join(launch.directory, siblings[0]), 'utf8')).trim()).toBe('replacement');
  }, 35_000);

  it('retains conservative malformed and unreadable final handling', async () => {
    const { options, dependencies } = await fixture();
    const launch = await prepareBridgeLaunch(options, dependencies);
    await writeFile(join(launch.directory, 'started.json'), '{"pid":');
    await expect(launch.completion()).rejects.toThrow('CONFIG_UNREADABLE');
    await rm(join(launch.directory, 'started.json'));
    await mkdir(join(launch.directory, 'started.json'));
    await expect(launch.completion()).rejects.toThrow('CONFIG_UNREADABLE');
    await writeFile(join(launch.directory, 'completed'), 'ex');
    expect(await launch.completion()).toBe('failed');
    await rm(join(launch.directory, 'completed'));
    await mkdir(join(launch.directory, 'completed'));
    await expect(launch.completion()).rejects.toThrow('LAUNCH_STATUS_UNREADABLE');
  }, 35_000);
});
