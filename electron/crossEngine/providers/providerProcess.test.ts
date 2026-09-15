// @vitest-environment node
import { describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { existsSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { attachStderrRingBuffer, buildCodexChildEnv } from '../acpProcess';
import { spawnProviderProcess, disposeProviderProcess } from './providerProcess';

// Native ESM namespace properties cannot be spied on. This test-local facade
// initially exports the actual functions; interception below is synchronous.
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>() }));

// Derived diagnostic host, not the byte-identical production baseline. Keep all
// original statements and parameter bytes; only stderr stage markers are added.
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

const recognizedHostStages: readonly string[] = hostStageAnchors.map(([stage]) => stage);

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

function spawnInstrumentedHost(parameters: Parameters<typeof spawnProviderProcess>) {
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
  started = Date.now(), privatePaths: string[] = [], instrumented = false, budgetMs = 20_000) {
  const stderr = attachStderrRingBuffer(child);
  const safe = (text: string) => privatePaths.reduce((value, path) => value.split(path).join('[private-path]'), text)
    .replace(/[A-Za-z0-9+/]{128,}={0,2}/g, '[encoded-command]');
  let lastHostStage: string | null = null, pendingStderr = '';
  const seenStages = new Map<string, number>();
  const phase = (event: string, detail: Record<string, unknown> = {}) => report({ event,
    elapsedMs: Date.now() - started, ...detail, ...(instrumented ? { lastHostStage } : {}), stderr: safe(stderr()) });
  const stageData = (chunk: Buffer) => {
    pendingStderr = (pendingStderr + chunk.toString()).slice(-8192);
    const lines = pendingStderr.split(/\r?\n/);
    pendingStderr = lines.pop()!;
    for (const line of lines) {
      const stage = recognizedHostStages.find(name => line === `[aether-test-host-stage:${name}]`);
      if (stage && !seenStages.has(stage)) {
        seenStages.set(stage, Date.now() - started); lastHostStage = stage; phase('host-stage', { stage });
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
  const checkpoint = setTimeout(() => phase('budget-nearly-exhausted', { budgetMs }),
    Math.max(0, budgetMs - 1000 - (Date.now() - started)));
  phase('startup-wait');
  return { firstOutput, phase, stageElapsedMs: (stage: string) => seenStages.get(stage) ?? null,
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

const powerShellEnvKeys = ['PSModulePath', 'PSModuleAnalysisCachePath'] as const;

function withoutPowerShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...env };
  for (const key of Object.keys(child)) {
    if (powerShellEnvKeys.some(canonical => canonical.toUpperCase() === key.toUpperCase())) delete child[key];
  }
  return child;
}

function diagnosticPowerShellPaths(env: NodeJS.ProcessEnv): string[] {
  return [...new Set(Object.entries(env).flatMap(([key, value]) => {
    if (!value || !powerShellEnvKeys.some(canonical => canonical.toUpperCase() === key.toUpperCase())) return [];
    // A module search path can be reported as a whole or as an individual entry.
    return key.toUpperCase() === 'PSMODULEPATH' ? [value, ...value.split(';').filter(Boolean)] : [value];
  }))];
}

describe('provider process containment', () => {
  const pendingMatrixCleanup = new Map<string, number>();
  // One fixed-order diagnostic pass, not randomized causal evidence. A timed-out
  // earlier host can remain unresolved while later arms run; retain arm labels.
  for (const [index, configuration] of [
    { selection: 'production', budgetMs: 20_000 },
  ].entries()) {
    const { selection, budgetMs } = configuration, order = index + 1;
    it.runIf(process.platform === 'win32')(`compares instrumented host arm ${order}: ${selection} / overrides on`, async () => {
      const started = Date.now();
      const privateRoot = mkdtempSync(join(tmpdir(), 'aether-private-cwd-'));
      const cwd = privateRoot;
      const expectedCwd = privateRoot;
      const arm = `${selection}/overrides-on/private`;
      const report = (value: unknown) => console.error('[provider-env-cwd]', JSON.stringify({
        arm, order, environment: selection, overrides: 'on', workingDirectory: 'private', budgetMs,
        precedingCleanupUnconfirmed: [...pendingMatrixCleanup].filter(([, priorOrder]) => priorOrder < order).map(([priorArm]) => priorArm),
        ...(value as Record<string, unknown>),
      }));
      const keys = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'Path', 'PATH'];
      const hadApiKey = Object.hasOwn(process.env, 'OPENAI_API_KEY');
      const previousApiKey = process.env.OPENAI_API_KEY;
      let env: NodeJS.ProcessEnv;
      let powerShellPaths: string[] = [];
      let child: ReturnType<typeof spawnInstrumentedHost>;
      try {
        // Select from the live Windows proxy exactly once. Keep the harmless
        // sentinel through synchronous spawn and restore before any await.
        process.env.OPENAI_API_KEY = 'must-not-inherit';
        const production = buildCodexChildEnv(process.env, privateRoot);
        powerShellPaths = diagnosticPowerShellPaths(production);
        env = selection === 'production' ? production : withoutPowerShellEnv(production);
        report({ event: 'key-selection', sourceBase: 'live-process-env-production-builder',
          removedKeys: selection === 'production' ? [] : powerShellEnvKeys,
          powerShellConfiguration: Object.fromEntries(powerShellEnvKeys.map(key => [key, {
            parentPresent: process.env[key] !== undefined,
            childPresent: Object.hasOwn(env, key),
            verbatimFromLiveParent: Object.hasOwn(env, key) && process.env[key] !== undefined
              ? env[key] === process.env[key] : null,
          }])) });
        report({ event: 'spawn-request', elapsedMs: Date.now() - started, node: process.version,
          osEnvPresent: Object.fromEntries(keys.map(key => [key, Object.hasOwn(process.env, key)])),
          childEnvPresent: Object.fromEntries(keys.map(key => [key, Object.hasOwn(env, key)])) });
        child = spawnInstrumentedHost([process.execPath, ['-e', 'console.log(JSON.stringify({cwd:process.cwd(),key:process.env.OPENAI_API_KEY??null}));setInterval(()=>{},1000)'], env, cwd]);
      } catch (error) {
        try { rmSync(privateRoot, { recursive: true, force: true }); }
        catch (cleanupError) {
          const reason = [privateRoot, expectedCwd, process.execPath, ...powerShellPaths].reduce((text, path) => text.split(path).join('[private-path]'),
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
      const trace = traceStartup(child, report, started,
        [privateRoot, expectedCwd, files, process.execPath, ...powerShellPaths], true, budgetMs);
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
        for (const key of powerShellEnvKeys) {
          const present = selection === 'production' && process.env[key] !== undefined;
          expect(Object.hasOwn(env, key), `${key} presence matches the selected case`).toBe(present);
          if (present) expect(env[key] === process.env[key], `${key} retains its parent value`).toBe(true);
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
      const before = trace.stageElapsedMs('add-type-before'), after = trace.stageElapsedMs('add-type-after');
      expect(before).not.toBeNull(); expect(after).not.toBeNull();
      expect(after!).toBeGreaterThanOrEqual(before!);
      expect(after!).toBeLessThan(budgetMs);
      expect(Date.now() - started).toBeLessThan(budgetMs);
      trace.phase('add-type-interval-confirmed', { addTypeIntervalMs: after! - before!, budgetMs });
    }, budgetMs);
  }
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
  it('removes only the two PowerShell keys in any casing without mutating the production selection', () => {
    const env = { PSModulePath: 'module-one', psmodulepath: 'module-alias', PSMODULEANALYSISCACHEPATH: '',
      PSModulePathExtra: 'retain-extra', PATH: 'os-path', CODEX_HOME: 'private-home', ELECTRON_RUN_AS_NODE: '1' };
    expect(withoutPowerShellEnv(env)).toEqual({ PSModulePathExtra: 'retain-extra', PATH: 'os-path',
      CODEX_HOME: 'private-home', ELECTRON_RUN_AS_NODE: '1' });
    expect(env.PSModulePath).toBe('module-one');
    expect(env.psmodulepath).toBe('module-alias');
    expect(env.PSMODULEANALYSISCACHEPATH).toBe('');
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
    const child = spawnInstrumentedHost([missingRoot ? join(missingRoot, 'absent.exe') : process.execPath, ['-e', 'process.exit(7)'], process.env]);
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
      expect(report.mock.calls.at(-1)![0]).toMatchObject({ event: 'budget-nearly-exhausted', budgetMs: 20_000, lastHostStage: 'ps-entry' });
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
      expect(report.mock.calls.at(-1)![0].event).toBe('budget-nearly-exhausted');
    } finally { trace.finish(); vi.useRealTimers(); }
  });
  it.each([20_000, 60_000])('places the %i ms checkpoint one second before its own budget', async budgetMs => {
    vi.useFakeTimers();
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const started = Date.now();
    await vi.advanceTimersByTimeAsync(250);
    const report = vi.fn(), trace = traceStartup(child, report, started, [], true, budgetMs);
    try {
      await vi.advanceTimersByTimeAsync(budgetMs - 1251);
      expect(report.mock.calls.some(([entry]) => entry.event === 'budget-nearly-exhausted')).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(report.mock.calls.at(-1)![0]).toMatchObject({ event: 'budget-nearly-exhausted', budgetMs,
        elapsedMs: budgetMs - 1000 });
    } finally { trace.finish(); vi.useRealTimers(); }
  });
  it.each(['C:/inherited-cache/private-analysis-cache', ''])('redacts nonempty PowerShell values and module-path segments (%s)', async cachePath => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const modulePath = 'C:/private-modules/one;D:/private-modules/two';
    const paths = diagnosticPowerShellPaths({ PsModuleAnalysisCachePath: cachePath, PSMODULEPATH: modulePath });
    expect(paths).toEqual([...(cachePath ? [cachePath] : []), modulePath, ...modulePath.split(';')]);
    const report = vi.fn(), trace = traceStartup(child, report, Date.now(), paths);
    const rejected = expect(trace.firstOutput).rejects.toThrow('before output');
    try {
      (child.stderr as PassThrough).write('PowerShell failed: ' + cachePath + ' ' + modulePath + ' C:/private-modules/one');
      trace.failure('startup-or-assertion-failed', new Error('PowerShell request failed: ' + cachePath + ' D:/private-modules/two'));
      expect(report.mock.calls.at(-1)![0]).toMatchObject({
        stderr: 'PowerShell failed: ' + (cachePath ? '[private-path]' : '') + ' [private-path] [private-path]',
        error: 'PowerShell request failed: ' + (cachePath ? '[private-path]' : '') + ' [private-path]',
      });
      child.emit('close', 1, null);
      await rejected;
      for (const path of paths) expect(JSON.stringify(report.mock.calls)).not.toContain(path);
    } finally { trace.finish(); }
  });
});
