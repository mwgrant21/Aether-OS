// @vitest-environment node
import { describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { existsSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { attachStderrRingBuffer, buildAllowlistedChildEnv, buildCodexChildEnv } from '../acpProcess';
import { spawnProviderProcess, disposeProviderProcess } from './providerProcess';

// Native ESM namespace properties cannot be spied on. This test-local facade
// initially exports the actual functions; interception below is synchronous.
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>() }));

// Derived diagnostic host, not the byte-identical production baseline. Keep all
// original statements and parameter bytes; only insert constant stderr writes.
const hostStageAnchors = [
  ['ps-entry', "$ErrorActionPreference='Stop'", 'before', 'ps'],
  ['add-type-before', "Add-Type -TypeDefinition @'", 'before', 'ps'],
  ['add-type-after', "'@\n$p=", 'before', 'after-here-string'],
  ['run-entry', 'public static void Run(string exe,string command,string stop,string receipt,string cwd) {', 'after', 'cs'],
  ['create-before', 'Check(CreateProcess(exe,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,String.IsNullOrEmpty(cwd)?null:cwd,ref si,out child));', 'before', 'cs'],
  ['create-after', 'Check(CreateProcess(exe,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,String.IsNullOrEmpty(cwd)?null:cwd,ref si,out child));', 'after', 'cs'],
  ['assign-before', 'Check(AssignProcessToJobObject(job,child.process)); assigned=true;', 'before', 'cs'],
  ['assign-after', 'Check(AssignProcessToJobObject(job,child.process)); assigned=true;', 'after', 'cs'],
  ['resume-before', 'Check(ResumeThread(child.thread)!=0xffffffff);', 'before', 'cs'],
  ['resume-after', 'Check(ResumeThread(child.thread)!=0xffffffff);', 'after', 'cs'],
  ['stop-wait-before', 'while(!File.Exists(stop) && WaitForSingleObject(child.process,50)==258) {}', 'before', 'cs'],
  ['stop-wait-after', 'while(!File.Exists(stop) && WaitForSingleObject(child.process,50)==258) {}', 'after', 'cs'],
  ['terminate-before', 'Check(TerminateJobObject(job,1));', 'before', 'cs'],
  ['terminate-after', 'Check(TerminateJobObject(job,1));', 'after', 'cs'],
  ['job-empty', 'File.WriteAllText(receipt,"empty");', 'before', 'cs'],
  ['receipt-written', 'File.WriteAllText(receipt,"empty");', 'after', 'cs'],
  ['host-complete', '[AetherProviderJob]::Run($p.executable,$p.command,$p.stop,$p.receipt,$p.cwd)', 'after', 'ps'],
] as const;

function instrumentHostScript(script: string): string {
  for (const [stage, anchor] of hostStageAnchors) {
    if (script.split(anchor).length !== 2) throw new Error(`Host instrumentation anchor must occur exactly once: ${stage}`);
  }
  for (const [stage, anchor, side, language] of hostStageAnchors) {
    const marker = `[aether-test-host-stage:${stage}]`;
    const write = language === 'cs' ? `Console.Error.WriteLine("${marker}");`
      : `[Console]::Error.WriteLine('${marker}')`;
    // A PowerShell here-string terminator must stay alone at column zero.
    script = script.replace(anchor, language === 'after-here-string' ? `'@\n${write}\n$p=`
      : side === 'before' ? `${write}\n${anchor}` : `${anchor}\n${write}`);
  }
  return script;
}

function spawnInstrumentedHost(...parameters: Parameters<typeof spawnProviderProcess>) {
  const realSpawn = childProcess.spawn;
  // Only the production host's three-argument overload is supported here.
  const interception = vi.spyOn(childProcess, 'spawn').mockImplementation(((command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    if (!Array.isArray(args) || args.length !== 5 || args[3] !== '-EncodedCommand') {
      throw new Error('Unexpected provider host spawn shape');
    }
    const script = Buffer.from(args[4], 'base64').toString('utf16le');
    let instrumented: string;
    try { instrumented = Buffer.from(instrumentHostScript(script), 'utf16le').toString('base64'); }
    catch (error) {
      // Production allocated this empty directory before calling spawn. No host
      // owns it yet; remove only that empty directory, never recursively.
      try { rmdirSync(supervisionDirectory({ spawnargs: [...args] })); }
      catch (cleanupError) {
        const reason = error instanceof Error ? error.message.slice(0, 256) : 'unknown instrumentation error';
        const code = (cleanupError as NodeJS.ErrnoException).code ?? 'unknown';
        throw new AggregateError([error, cleanupError], `${reason}; empty-directory cleanup failed (${code})`);
      }
      throw error;
    }
    return realSpawn(command, [...args.slice(0, -1), instrumented], options);
  }) as unknown as typeof childProcess.spawn);
  try { return spawnProviderProcess(...parameters); }
  finally { interception.mockRestore(); }
}

function supervisionDirectory(child: Pick<ChildProcessWithoutNullStreams, 'spawnargs'>): string {
  const hostScript = Buffer.from(child.spawnargs.at(-1)!, 'base64').toString('utf16le');
  const encoded = /FromBase64String\('([^']+)'\)/.exec(hostScript)![1];
  return dirname(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')).stop);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** Test-only diagnostics; never include stdout, environment values or spawn arguments. */
function traceStartup(child: ChildProcessWithoutNullStreams, report: (value: unknown) => void,
  started = Date.now(), privatePaths: string[] = [], instrumented = false) {
  const stderr = attachStderrRingBuffer(child);
  const safe = (text: string) => privatePaths.reduce((value, path) => value.split(path).join('[private-path]'), text)
    .replace(/[A-Za-z0-9+/]{128,}={0,2}/g, '[encoded-command]');
  let lastHostStage: string | null = null, pendingStderr = '';
  const seenStages = new Set<string>();
  const phase = (event: string, detail: Record<string, unknown> = {}) => report({ event,
    elapsedMs: Date.now() - started, ...detail, ...(instrumented ? { lastHostStage } : {}), stderr: safe(stderr()) });
  const stageData = (chunk: Buffer) => {
    pendingStderr = (pendingStderr + chunk.toString()).slice(-8192);
    const lines = pendingStderr.split(/\r?\n/);
    pendingStderr = lines.pop()!;
    for (const line of lines) {
      const stage = hostStageAnchors.find(([name]) => line === `[aether-test-host-stage:${name}]`)?.[0];
      if (stage && !seenStages.has(stage)) {
        seenStages.add(stage); lastHostStage = stage; phase('host-stage', { stage });
      }
    }
  };
  if (instrumented) child.stderr.on('data', stageData);
  let received = false;
  let resolve!: (value: Buffer) => void, reject!: (error: Error) => void;
  const firstOutput = new Promise<Buffer>((yes, no) => { resolve = yes; reject = no; });
  const data = (chunk: Buffer) => { received = true; phase('first-output', { bytes: chunk.length }); resolve(chunk); };
  const spawn = () => phase('spawn');
  const error = (failure: NodeJS.ErrnoException) => {
    phase('error', { code: failure.code ?? null });
    if (!received) reject(new Error(`Provider host error before output: ${failure.code ?? 'unknown'}`));
  };
  const exit = (code: number | null, signal: string | null) => phase('exit', { code, signal });
  const close = (code: number | null, signal: string | null) => {
    phase('close', { code, signal });
    if (!received) reject(new Error(`Provider host closed before output: ${code ?? signal ?? 'unknown'}`));
  };
  child.stdout.once('data', data); child.on('spawn', spawn); child.on('error', error);
  child.on('exit', exit); child.on('close', close);
  const checkpoint = setTimeout(() => phase('20s-budget-nearly-exhausted'), Math.max(0, 19_000 - (Date.now() - started)));
  phase('startup-wait');
  return { firstOutput, phase,
    failure: (event: string, error: unknown) => phase(event, {
      error: safe(error instanceof Error ? error.message : String(error)).slice(0, 1024),
    }), finish: () => {
    clearTimeout(checkpoint); child.stdout.off('data', data); child.off('spawn', spawn);
    child.off('error', error); child.off('exit', exit); child.off('close', close);
    child.stderr.off('data', stageData);
  } };
}

function ownedFixtureCleanup(child: { disposeTree(): Promise<void> }, remove: () => void, phase: (event: string) => void) {
  let cleanup: Promise<void> | undefined;
  return () => cleanup ??= (async () => {
    phase('cleanup-start');
    await child.disposeTree();
    phase('tree-cleanup-confirmed');
    remove();
    phase('cleanup-complete');
  })();
}

// Preserve the live Windows environment proxy's OS aliases before enumerating
// dropped entries. This normalized full base is not the untouched parent env.
function diagnosticEnvBases(osEnv: NodeJS.ProcessEnv) {
  const overrideKeys = new Set(['CODEX_HOME', 'ELECTRON_RUN_AS_NODE']);
  const sanitized = buildAllowlistedChildEnv(osEnv);
  for (const key of Object.keys(sanitized)) if (overrideKeys.has(key.toUpperCase())) delete sanitized[key];
  const retained = new Set(Object.keys(sanitized).map(key => key.toUpperCase()));
  const full = { ...sanitized }, droppedKeys: string[] = [];
  for (const key of Object.keys(osEnv).sort()) {
    const normalized = key.toUpperCase();
    if (overrideKeys.has(normalized) || retained.has(normalized) || osEnv[key] === undefined) continue;
    retained.add(normalized); full[key] = osEnv[key]; droppedKeys.push(key);
  }
  const parentOverridePresent = Object.fromEntries([...overrideKeys].map(key =>
    [key, Object.keys(osEnv).some(name => name.toUpperCase() === key && osEnv[name] !== undefined)]));
  return { sanitized, full, droppedKeys, parentOverridePresent };
}

function diagnosticArmEnv(bases: ReturnType<typeof diagnosticEnvBases>, environment: 'full' | 'sanitized',
  overrides: 'on' | 'off', codexHome: string): NodeJS.ProcessEnv {
  const env = { ...bases[environment] };
  if (overrides === 'on') {
    const production = buildCodexChildEnv(bases.sanitized, codexHome);
    env.CODEX_HOME = production.CODEX_HOME;
    env.ELECTRON_RUN_AS_NODE = production.ELECTRON_RUN_AS_NODE;
  }
  return env;
}

// Diagnostic partitions only: these lists never widen the production allowlist.
const diagnosticGroups = [
  { name: 'windows-machine-identity', exact: 'USERNAME USERDOMAIN USERDOMAIN_ROAMINGPROFILE LOGONSERVER COMPUTERNAME OS PROCESSOR_ARCHITECTURE PROCESSOR_IDENTIFIER PROCESSOR_LEVEL PROCESSOR_REVISION NUMBER_OF_PROCESSORS SYSTEMDRIVE DRIVERDATA PUBLIC ALLUSERSPROFILE PROGRAMDATA PROGRAMFILES PROGRAMFILES(X86) PROGRAMW6432 COMMONPROGRAMFILES COMMONPROGRAMFILES(X86) COMMONPROGRAMW6432 PROMPT', prefixes: [] },
  { name: 'powershell-dotnet', exact: 'PSMODULEPATH PSMODULEANALYSISCACHEPATH POWERSHELL_DISTRIBUTION_CHANNEL POWERSHELL_UPDATECHECK DOTNET_MULTILEVEL_LOOKUP DOTNET_NOLOGO DOTNET_SKIP_FIRST_TIME_EXPERIENCE', prefixes: [] },
  { name: 'github-runner', exact: 'CI ENABLE_RUNNER_TRACING AGENT_TOOLSDIRECTORY IMAGEOS IMAGEVERSION', prefixes: ['ACTIONS_', 'GITHUB_', 'RUNNER_'] },
  { name: 'node-npm-vitest', exact: 'NODE NODE_ENV INIT_CWD VITEST VITEST_MODE VITEST_POOL_ID VITEST_WORKER_ID TINYPOOL_WORKER_ID COLOR EDITOR MODE DEV PROD TEST SSR BASE_URL OPENAI_API_KEY', prefixes: ['NPM_'] },
  { name: 'toolchains', exact: 'ANT_HOME CABAL_DIR CHOCOLATEYINSTALL CHROMEWEBDRIVER EDGEWEBDRIVER GECKOWEBDRIVER IEWEBDRIVER COBERTURA_HOME CONDA GCM_INTERACTIVE GRADLE_HOME M2 M2_REPO MAVEN_OPTS PHPROOT RTOOLS45_HOME SBT_HOME SELENIUM_JAR_PATH VCPKG_INSTALLATION_ROOT WIX', prefixes: ['ANDROID_', 'AZURE_', 'AZ_DEVOPS_', 'GHCUP_', 'GOROOT_', 'JAVA_HOME', 'PG', 'PIPX_'] },
] as const;
type DiagnosticGroup = typeof diagnosticGroups[number]['name'] | 'remainder';
type DiagnosticSelection = DiagnosticGroup | 'full-control' | 'sanitized-control';
const diagnosticSelections: readonly DiagnosticSelection[] = [
  'full-control', ...diagnosticGroups.map(group => group.name), 'remainder', 'sanitized-control',
];
const excludedDiagnosticKeys = ['OPENAI_API_KEY'];

function diagnosticGroup(key: string): DiagnosticGroup {
  const name = key.toUpperCase();
  return diagnosticGroups.find(group => group.exact.split(' ').includes(name)
    || group.prefixes.some(prefix => name.startsWith(prefix)))?.name ?? 'remainder';
}

function diagnosticGroupArm(bases: ReturnType<typeof diagnosticEnvBases>, selection: DiagnosticSelection, codexHome: string) {
  const matchedKeys = bases.droppedKeys.filter(key => selection === 'full-control'
    || selection !== 'sanitized-control' && diagnosticGroup(key) === selection);
  const excludedKeys = matchedKeys.filter(key => excludedDiagnosticKeys.includes(key.toUpperCase()));
  const appliedKeys = matchedKeys.filter(key => !excludedDiagnosticKeys.includes(key.toUpperCase()));
  const env = diagnosticArmEnv(bases, 'sanitized', 'on', codexHome);
  for (const key of appliedKeys) env[key] = bases.full[key];
  // Enforce the payload's null contract even if the sanitized base ever changes.
  for (const key of Object.keys(env)) if (excludedDiagnosticKeys.includes(key.toUpperCase())) delete env[key];
  return { env, matchedKeys, excludedKeys, appliedKeys };
}

function diagnosticKeyNames(keys: string[]) {
  return { count: keys.length, names: keys.slice(0, 256).map(key => key.slice(0, 128)),
    truncated: keys.length > 256 || keys.some(key => key.length > 128) };
}

describe('provider process containment', () => {
  const pendingMatrixCleanup = new Map<string, number>();
  let sharedBases: ReturnType<typeof diagnosticEnvBases> | undefined;
  // One fixed-order diagnostic pass, not randomized causal evidence. A timed-out
  // earlier host can remain unresolved while later arms run; retain arm labels.
  it.runIf(process.platform === 'win32').each(diagnosticSelections.map((selection, index) => ({ selection, order: index + 1 })))
  ('compares instrumented host arm $order: $selection / overrides on', async ({ order, selection }) => {
    const started = Date.now();
    const privateRoot = mkdtempSync(join(tmpdir(), 'aether-private-cwd-'));
    const cwd = privateRoot;
    const expectedCwd = privateRoot;
    const arm = `${selection}/overrides-on/private`;
    const report = (value: unknown) => console.error('[provider-env-cwd]', JSON.stringify({
      arm, order, environment: selection, overrides: 'on', workingDirectory: 'private', droppedKeyCount: sharedBases?.droppedKeys.length ?? null,
      precedingCleanupUnconfirmed: [...pendingMatrixCleanup].filter(([, priorOrder]) => priorOrder < order).map(([priorArm]) => priorArm),
      ...(value as Record<string, unknown>),
    }));
    const keys = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'Path', 'PATH'];
    const hadApiKey = Object.hasOwn(process.env, 'OPENAI_API_KEY');
    const previousApiKey = process.env.OPENAI_API_KEY;
    let env: NodeJS.ProcessEnv;
    let child: ReturnType<typeof spawnInstrumentedHost>;
    try {
      // The frozen snapshot is taken under a sentinel, never a real API key.
      // Every arm excludes the key before synchronous spawn; restore the live
      // environment before any await, including on setup/spawn failure.
      process.env.OPENAI_API_KEY = 'must-not-inherit';
      if (!sharedBases) {
        sharedBases = diagnosticEnvBases(process.env);
        const names = sharedBases.droppedKeys;
        report({ event: 'environment-selection', fullBase: 'normalized-retained-plus-dropped-excluding-diagnostic-keys',
          excludedDiagnosticKeys,
          parentOverridePresent: sharedBases.parentOverridePresent,
          droppedKeys: names.slice(0, 256).map(key => key.slice(0, 128)),
          droppedKeyNamesTruncated: names.length > 256 || names.some(key => key.length > 128) });
      }
      const selected = diagnosticGroupArm(sharedBases, selection, privateRoot);
      env = selected.env;
      report({ event: 'group-selection', selection, excludedDiagnosticKeys,
        matched: diagnosticKeyNames(selected.matchedKeys), applied: diagnosticKeyNames(selected.appliedKeys),
        excluded: diagnosticKeyNames(selected.excludedKeys) });
      report({ event: 'spawn-request', elapsedMs: Date.now() - started, node: process.version,
        osEnvPresent: Object.fromEntries(keys.map(key => [key, Object.hasOwn(process.env, key)])),
        childEnvPresent: Object.fromEntries(keys.map(key => [key, Object.hasOwn(env, key)])) });
      child = spawnInstrumentedHost(process.execPath, ['-e', 'console.log(JSON.stringify({cwd:process.cwd(),key:process.env.OPENAI_API_KEY??null}));setInterval(()=>{},1000)'], env, cwd);
    } catch (error) {
      try { rmSync(privateRoot, { recursive: true, force: true }); }
      catch (cleanupError) {
        const reason = [privateRoot, expectedCwd, process.execPath].reduce((text, path) => text.split(path).join('[private-path]'),
          error instanceof Error ? error.message : String(error)).replace(/[A-Za-z0-9+/]{128,}={0,2}/g, '[encoded-command]').slice(0, 1024);
        const code = (cleanupError as NodeJS.ErrnoException).code ?? 'unknown';
        throw new AggregateError([error, cleanupError], `${reason}; fixture-directory cleanup failed (${code})`);
      }
      throw error;
    } finally {
      if (hadApiKey) process.env.OPENAI_API_KEY = previousApiKey!;
      else delete process.env.OPENAI_API_KEY;
    }
    pendingMatrixCleanup.set(arm, order);
    report({ event: 'instrumented-host-spawn', commandCharsUpperBound: child.spawnargs.reduce((length, arg) => length + arg.length + 3, 1) });
    const files = supervisionDirectory(child);
    const trace = traceStartup(child, report, started, [privateRoot, expectedCwd, files, process.execPath], true);
    let cleanupObserved = false;
    const dispose = ownedFixtureCleanup(child, () => {
      expect(existsSync(files)).toBe(false);
      rmSync(privateRoot, { recursive: true, force: true });
      pendingMatrixCleanup.delete(arm);
    }, trace.phase);
    onTestFailed(() => trace.phase('test-failed'));
    onTestFinished(async () => {
      // Vitest timing out does not unwind the suspended test body. Retain the
      // same disposal owner and its evidence instead of abandoning the host.
      trace.phase('test-finished-hook');
      try { if (!cleanupObserved) await dispose(); }
      catch (error) { trace.failure('cleanup-failed', error); throw error; }
      finally { trace.finish(); }
    });
    const failures: unknown[] = [];
    try {
      const first = await trace.firstOutput;
      trace.phase('assertions-start');
      for (const key of keys) if (process.env[key] !== undefined) {
        expect(Object.hasOwn(env, key), `${key} retained as an exact child key`).toBe(true);
        expect(env[key] === process.env[key], `${key} retains its OS value`).toBe(true);
      }
      expect(Object.keys(env).some(key => key.toUpperCase() === 'OPENAI_API_KEY')).toBe(false);
      expect(JSON.parse(String(first))).toEqual({ cwd: expectedCwd, key: null });
      expect(existsSync(files)).toBe(true);
      trace.phase('assertions-passed');
    } catch (error) { failures.push(error); trace.failure('startup-or-assertion-failed', error);
    } finally {
      try { await dispose(); } catch (error) { failures.push(error); trace.failure('cleanup-failed', error); }
      cleanupObserved = true;
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Provider fixture and cleanup both failed');
  }, 20_000);
  it.runIf(process.platform === 'win32')('preserves raw stdio and proves a stubborn real descendant has exited', async () => {
    const script = `const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
      console.log(JSON.stringify({pid:process.pid,descendant:child.pid}));
      process.stdin.on('data',data=>process.stdout.write(data));
      setInterval(()=>{},1000);`;
    const child = spawnProviderProcess(process.execPath, ['-e', script], process.env);
    let stderr = '';
    child.stderr.on('data', data => { stderr += String(data); });
    try {
      const [first] = await Promise.race([
        once(child.stdout, 'data'),
        once(child, 'close').then(() => { throw new Error('host closed before ready: ' + stderr); }),
      ]);
      const ids = JSON.parse(String(first)) as { pid: number; descendant: number };
      expect(alive(ids.pid)).toBe(true);
      expect(alive(ids.descendant)).toBe(true);
      const echoed = once(child.stdout, 'data');
      child.stdin.write('raw π payload\n');
      expect(String((await echoed)[0])).toBe('raw π payload\n');
      const one = child.disposeTree();
      expect(child.disposeTree()).toBe(one);
      await one;
      expect(alive(ids.pid)).toBe(false);
      expect(alive(ids.descendant)).toBe(false);
    } finally { await child.disposeTree(); }
  }, 20_000);

  it.runIf(process.platform === 'win32')('reaps descendants after their immediate wrapper has exited', async () => {
    const script = `const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:'ignore'});
      console.log(child.pid);child.unref();setTimeout(()=>process.exit(0),100);`;
    const child = spawnProviderProcess(process.execPath, ['-e', script], process.env);
    child.stderr.resume();
    const [first] = await once(child.stdout, 'data');
    const descendant = Number(String(first).trim());
    await once(child, 'close');
    await child.disposeTree();
    expect(alive(descendant)).toBe(false);
  }, 20_000);

  it('propagates a failed kill rather than converting it to disposal success', async () => {
    const failure = new Error('job termination denied');
    const child = { disposeTree: async () => { throw failure; } };
    await expect(disposeProviderProcess(child as never)).rejects.toBe(failure);
    await expect(disposeProviderProcess({} as never)).rejects.toThrow('no tree supervisor');
  });

  it('refuses unsupported platforms before starting a provider', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    try {
      expect(() => spawnProviderProcess(process.execPath, [], process.env)).toThrow('requires Windows');
    } finally { platform.mockRestore(); }
  });

  it.runIf(process.platform === 'win32')('host crash kills its job but never invents a cleanup receipt', async () => {
    const child = spawnProviderProcess(process.execPath, ['-e', 'console.log(process.pid);setInterval(()=>{},1000)'], process.env);
    child.stderr.resume();
    const files = supervisionDirectory(child);
    const [first] = await once(child.stdout, 'data');
    const root = Number(String(first).trim());
    expect(existsSync(files)).toBe(true);
    const closed = once(child, 'close');
    child.kill();
    await closed;
    await expect(child.disposeTree()).rejects.toThrow();
    expect(existsSync(files)).toBe(false);
    await expect(child.disposeTree()).rejects.toThrow('cleanup was not confirmed');
    const deadline = Date.now() + 3000;
    while (alive(root) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(alive(root)).toBe(false);
  }, 20_000);
});

describe('provider diagnostic environment selection', () => {
  it('classifies exact and prefix boundaries case-insensitively with an exhaustive remainder', () => {
    const cases: Record<DiagnosticGroup, string[]> = {
      'windows-machine-identity': ['username', 'ProgramFiles(x86)', 'COMMONPROGRAMW6432', 'Prompt'],
      'powershell-dotnet': ['psmodulepath', 'DOTNET_SKIP_FIRST_TIME_EXPERIENCE'],
      'github-runner': ['actions_runtime', 'Github_job', 'RUNNER_OS', 'CI', 'IMAGEVERSION'],
      'node-npm-vitest': ['npm_config_cache', 'node_env', 'VITEST_POOL_ID', 'OPENAI_API_KEY'],
      toolchains: ['android_home', 'AZ_DEVOPS_TEST', 'JAVA_HOME_17_X64', 'pg', 'PGROOT', 'PIPX_HOME', 'M2'],
      remainder: ['USERNAME_EXTRA', 'DOTNET_OTHER', 'GITHUB', 'NODE_OPTIONS', 'JAVA', 'UNKNOWN_FIXTURE'],
    };
    for (const [group, names] of Object.entries(cases)) for (const name of names) expect(diagnosticGroup(name), name).toBe(group);
    expect(diagnosticSelections).toEqual(['full-control', 'windows-machine-identity', 'powershell-dotnet',
      'github-runner', 'node-npm-vitest', 'toolchains', 'remainder', 'sanitized-control']);
    expect(diagnosticKeyNames(['x'.repeat(129)]).truncated).toBe(true);
    expect(diagnosticKeyNames(Array.from({ length: 257 }, (_, i) => `KEY_${i}`))).toMatchObject({ count: 257, truncated: true });
  });
  it('partitions every dropped key once and applies only the selected group with the API key excluded from all arms', () => {
    const parent = { SystemRoot: 'fixture-root', PATH: 'fixture-path', username: 'identity-value',
      PSMODULEPATH: 'powershell-value', Github_job: 'runner-value', NPM_CONFIG_CACHE: 'node-value',
      JAVA_HOME_17_X64: 'toolchain-value', UNKNOWN_FIXTURE: 'remainder-value',
      openai_api_key: 'must-not-inherit', CODEX_HOME: 'parent-home', ELECTRON_RUN_AS_NODE: '0' };
    const bases = diagnosticEnvBases(parent);
    const groups = diagnosticSelections.filter(selection => !selection.endsWith('-control'));
    const partition = groups.flatMap(selection => diagnosticGroupArm(bases, selection, 'fixture-home').matchedKeys);
    expect(partition.sort()).toEqual([...bases.droppedKeys].sort());
    expect(new Set(partition).size).toBe(bases.droppedKeys.length);
    for (const selection of diagnosticSelections) {
      const arm = diagnosticGroupArm(bases, selection, 'fixture-home');
      const expected = selection === 'full-control' ? Object.keys(parent).filter(key => partition.includes(key) && key !== 'openai_api_key')
        : selection === 'sanitized-control' ? [] : Object.entries({ username: 'windows-machine-identity', PSMODULEPATH: 'powershell-dotnet',
          Github_job: 'github-runner', NPM_CONFIG_CACHE: 'node-npm-vitest', JAVA_HOME_17_X64: 'toolchains', UNKNOWN_FIXTURE: 'remainder' })
          .filter(([, group]) => group === selection).map(([key]) => key);
      expect(arm.appliedKeys.sort()).toEqual(expected.sort());
      expect(arm.excludedKeys).toEqual(['full-control', 'node-npm-vitest'].includes(selection) ? ['openai_api_key'] : []);
      expect(arm.env).toEqual({ ...bases.sanitized, CODEX_HOME: 'fixture-home', ELECTRON_RUN_AS_NODE: '1',
        ...Object.fromEntries(expected.map(key => [key, parent[key as keyof typeof parent]])) });
      expect(Object.keys(arm.env).some(key => key.toUpperCase() === 'OPENAI_API_KEY')).toBe(false);
    }
    expect(parent.openai_api_key).toBe('must-not-inherit');
  });

  it('separates dropped keys and overrides without retaining mixed-case parent override aliases', () => {
    const parent = { SystemRoot: 'os-root', PATH: 'os-path', SECRET_FIXTURE: 'fixture-only',
      OPENAI_API_KEY: 'must-not-inherit', codex_home: 'parent-home', CODEX_HOME: 'other-parent-home',
      Electron_Run_As_Node: '0', ELECTRON_RUN_AS_NODE: 'parent-node-mode' };
    const bases = diagnosticEnvBases(parent);
    expect(bases.droppedKeys).toEqual(['OPENAI_API_KEY', 'SECRET_FIXTURE']);
    expect(bases.parentOverridePresent).toEqual({ CODEX_HOME: true, ELECTRON_RUN_AS_NODE: true });
    expect(bases.sanitized).toEqual({ PATH: 'os-path', SystemRoot: 'os-root' });
    for (const environment of ['full', 'sanitized'] as const) for (const overrides of ['off', 'on'] as const) {
      const env = diagnosticArmEnv(bases, environment, overrides, 'fixture-home');
      expect(Object.keys(env).filter(key => ['CODEX_HOME', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())))
        .toEqual(overrides === 'on' ? ['CODEX_HOME', 'ELECTRON_RUN_AS_NODE'] : []);
      expect(env.SECRET_FIXTURE).toBe(environment === 'full' ? 'fixture-only' : undefined);
      expect(env.OPENAI_API_KEY).toBe(environment === 'full' ? 'must-not-inherit' : undefined);
      if (overrides === 'on') expect([env.CODEX_HOME, env.ELECTRON_RUN_AS_NODE]).toEqual(['fixture-home', '1']);
    }
    expect(bases.full).toEqual({ ...bases.sanitized, OPENAI_API_KEY: 'must-not-inherit', SECRET_FIXTURE: 'fixture-only' });
    expect(parent.codex_home).toBe('parent-home');
  });
  it('keeps sanitized/on identical to the production builder on the live environment', () => {
    const bases = diagnosticEnvBases(process.env);
    expect(diagnosticArmEnv(bases, 'sanitized', 'on', 'fixture-home'))
      .toEqual(buildCodexChildEnv(process.env, 'fixture-home'));
    for (const key of Object.keys(bases.sanitized)) expect(bases.full[key]).toBe(bases.sanitized[key]);
  });
});

describe('provider startup diagnostic failure paths', () => {
  it('rejects every missing or duplicated host anchor instead of instrumenting stale source', () => {
    const script = [...new Set(hostStageAnchors.map(([, anchor]) => anchor))].join('\n');
    for (const [stage, anchor] of hostStageAnchors) {
      const firstStage = hostStageAnchors.find(([, value]) => value === anchor)![0];
      expect(() => instrumentHostScript(script.replace(anchor, '')), stage).toThrow(`exactly once: ${firstStage}`);
      expect(() => instrumentHostScript(script + '\n' + anchor), stage).toThrow(`exactly once: ${firstStage}`);
    }
  });
  it.runIf(process.platform === 'win32').each(['early exit', 'missing executable'])('retains instrumented native stage evidence after %s', async outcome => {
    const originalSpawn = childProcess.spawn;
    const missingRoot = outcome === 'missing executable' ? mkdtempSync(join(tmpdir(), 'aether-missing-exe-')) : undefined;
    const child = spawnInstrumentedHost(missingRoot ? join(missingRoot, 'absent.exe') : process.execPath, ['-e', 'process.exit(7)'], process.env);
    const report = vi.fn(), trace = traceStartup(child, report, Date.now(), [supervisionDirectory(child), process.execPath], true);
    try {
      expect(childProcess.spawn).toBe(originalSpawn);
      await expect(trace.firstOutput).rejects.toThrow('closed before output');
      if (missingRoot) await expect(child.disposeTree()).rejects.toThrow('cleanup was not confirmed');
      else await child.disposeTree();
      expect(report.mock.calls.filter(([entry]) => entry.event === 'host-stage').map(([entry]) => entry.stage))
        .toEqual(hostStageAnchors.slice(0, missingRoot ? 5 : undefined).map(([stage]) => stage));
      expect(report.mock.calls.at(-1)![0]).toMatchObject({ event: 'close', lastHostStage: missingRoot ? 'create-before' : 'host-complete' });
    } finally {
      try {
        if (missingRoot) await expect(child.disposeTree()).rejects.toThrow('cleanup was not confirmed');
        else await child.disposeTree();
      } finally { trace.finish(); if (missingRoot) rmSync(missingRoot, { recursive: true, force: true }); }
    }
  }, 20_000);
  it('retains the last received stage at the timeout checkpoint without treating quoted markers as execution', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const report = vi.fn(), trace = traceStartup(child, report, Date.now(), [], true);
    try {
      (child.stderr as PassThrough).write('[aether-test-host-stage:ps-');
      await vi.advanceTimersByTimeAsync(50);
      (child.stderr as PassThrough).write('entry]\r\nsource: [aether-test-host-stage:host-complete]\r\n');
      expect(report.mock.calls.at(-1)![0]).toMatchObject({ event: 'host-stage', stage: 'ps-entry', elapsedMs: 50 });
      await vi.advanceTimersByTimeAsync(18_950);
      expect(report.mock.calls.at(-1)![0]).toMatchObject({ event: '20s-budget-nearly-exhausted', lastHostStage: 'ps-entry' });
      (child.stderr as PassThrough).write('[aether-test-host-stage:resume-after]\n[aether-test-host-stage:create-before]\n');
      expect(report.mock.calls.filter(([entry]) => entry.event === 'host-stage').map(([entry]) => entry.stage))
        .toEqual(['ps-entry', 'resume-after', 'create-before']);
      expect(report.mock.calls.at(-1)![0].lastHostStage).toBe('create-before');
    } finally { trace.finish(); vi.useRealTimers(); }
  });
  it.each(['success', 'failure'])('keeps delayed cleanup shared and retains its eventual %s', async outcome => {
    let resolve!: () => void, reject!: (error: Error) => void;
    const proof = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const child = { disposeTree: vi.fn(() => proof) }, remove = vi.fn(), phase = vi.fn();
    const dispose = ownedFixtureCleanup(child, remove, phase);
    const first = dispose(), observed = first.then(() => undefined, error => error);
    expect(dispose()).toBe(first); await Promise.resolve();
    expect(remove).not.toHaveBeenCalled();
    if (outcome === 'success') resolve(); else reject(new Error('unconfirmed tree'));
    expect(await observed).toEqual(outcome === 'success' ? undefined : new Error('unconfirmed tree'));
    expect(dispose()).toBe(first); expect(child.disposeTree).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
    expect(phase.mock.calls.map(([event]) => event)).toEqual(outcome === 'success'
      ? ['cleanup-start', 'tree-cleanup-confirmed', 'cleanup-complete'] : ['cleanup-start']);
  });
  it.each(['error', 'close'])('rejects early %s with bounded redacted stderr and elapsed events', async event => {
    vi.useFakeTimers();
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const report = vi.fn(), trace = traceStartup(child, report, Date.now(), ['C:/private-fixture']);
    const rejected = expect(trace.firstOutput).rejects.toThrow('before output');
    try {
      child.emit('spawn');
      (child.stderr as PassThrough).write('x'.repeat(9000) + '\nCompiler failed at C:/private-fixture');
      await vi.advanceTimersByTimeAsync(120);
      child.emit('exit', 1, null);
      child.emit(event, event === 'error' ? Object.assign(new Error('not logged command line'), { code: 'ENOENT' }) : 1, null);
      await rejected;
      const entries = report.mock.calls.map(([entry]) => entry);
      expect(entries.map(entry => entry.event)).toEqual(['startup-wait', 'spawn', 'exit', event]);
      expect(entries.at(-1)).toMatchObject({ elapsedMs: 120 });
      expect(entries.at(-1).stderr).toContain('Compiler failed at [private-path]');
      expect(entries.at(-1).stderr.length).toBeLessThanOrEqual(8192);
      expect(JSON.stringify(entries)).not.toContain('not logged command line');
      trace.failure('cleanup-failed', new Error('CONTROL_CLEANUP_FAILURE C:/private-fixture ' + 'x'.repeat(9000)));
      expect(report.mock.calls.at(-1)![0]).toMatchObject({ event: 'cleanup-failed',
        error: 'CONTROL_CLEANUP_FAILURE [private-path] [encoded-command]' });
      trace.failure('startup-or-assertion-failed', new Error('bounded failure '.repeat(200)));
      expect(report.mock.calls.at(-1)![0].error).toHaveLength(1024);
      await vi.advanceTimersByTimeAsync(18_880);
      expect(report.mock.calls.at(-1)![0].event).toBe('20s-budget-nearly-exhausted');
    } finally { trace.finish(); vi.useRealTimers(); }
  });
});
