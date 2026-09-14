// @vitest-environment node
import { describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { attachStderrRingBuffer, buildCodexChildEnv } from '../acpProcess';
import { spawnProviderProcess, disposeProviderProcess } from './providerProcess';

function supervisionDirectory(child: ReturnType<typeof spawnProviderProcess>): string {
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
  started = Date.now(), privatePaths: string[] = []) {
  const stderr = attachStderrRingBuffer(child);
  const safe = (text: string) => privatePaths.reduce((value, path) => value.split(path).join('[private-path]'), text)
    .replace(/[A-Za-z0-9+/]{128,}={0,2}/g, '[encoded-command]');
  const phase = (event: string, detail: Record<string, unknown> = {}) => report({ event,
    elapsedMs: Date.now() - started, ...detail, stderr: safe(stderr()) });
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

describe('provider process containment', () => {
  it.runIf(process.platform === 'win32')('launches the real child in its private cwd with the production sanitized environment', async () => {
    const started = Date.now();
    const cwd = mkdtempSync(join(tmpdir(), 'aether-private-cwd-'));
    const env = buildCodexChildEnv({ ...process.env, OPENAI_API_KEY: 'must-not-inherit' }, cwd);
    const report = (value: unknown) => console.error('[provider-private-cwd]', JSON.stringify(value));
    const keys = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'Path', 'PATH'];
    report({ event: 'spawn-request', elapsedMs: Date.now() - started, node: process.version,
      osEnvPresent: Object.fromEntries(keys.map(key => [key, Object.hasOwn(process.env, key)])),
      childEnvPresent: Object.fromEntries(keys.map(key => [key, Object.hasOwn(env, key)])) });
    const child = spawnProviderProcess(process.execPath, ['-e', 'console.log(JSON.stringify({cwd:process.cwd(),key:process.env.OPENAI_API_KEY??null}));setInterval(()=>{},1000)'], env, cwd);
    const files = supervisionDirectory(child);
    const trace = traceStartup(child, report, started, [cwd, files, process.execPath]);
    let cleanupObserved = false;
    const dispose = ownedFixtureCleanup(child, () => {
      expect(existsSync(files)).toBe(false);
      rmSync(cwd, { recursive: true, force: true });
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
      expect(JSON.parse(String(first))).toEqual({ cwd, key: null });
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

describe('provider startup diagnostic failure paths', () => {
  it.runIf(process.platform === 'win32')('reports a harmless native early exit instead of waiting for absent output', async () => {
    const child = spawnProviderProcess(process.execPath, ['-e', 'process.exit(7)'], process.env);
    const report = vi.fn(), trace = traceStartup(child, report);
    try {
      await expect(trace.firstOutput).rejects.toThrow('closed before output');
      expect(report.mock.calls.map(([entry]) => entry.event)).toEqual(['startup-wait', 'spawn', 'exit', 'close']);
    } finally { await child.disposeTree(); trace.finish(); }
  }, 20_000);
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
