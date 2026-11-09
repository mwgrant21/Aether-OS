import { describe, expect, it, vi } from 'vitest';
import { createSpawnRouter, type SpecLike } from './spawnRoute';
import { parseClientFrame } from './protocol';

const HOME = 'C:\\Users\\tester';
const spec = (over: Partial<SpecLike> = {}): SpecLike => ({
  file: 'powershell.exe', args: [], cwd: HOME, env: { PATH: 'x' }, cols: 80, rows: 24, writes: ['a'], ...over,
});
function setup(ready = true, nullClient = false) {
  const spawn = vi.fn((..._a: unknown[]) => 'REMOTE');
  const log = vi.fn();
  const client = nullClient ? null : { ready, spawn };
  return { spawn, log, route: createSpawnRouter<string>({ client, homedir: HOME, log }) };
}

describe('createSpawnRouter', () => {
  it.each([['not ready', false, false], ['null client', true, true]])('%s runs in-process and never builds a spec', (_n, ready, isNull) => {
    const { route, spawn } = setup(ready, isNull);
    const build = vi.fn(spec);
    expect(route('claude', build, {}, () => 'LOCAL')).toBe('LOCAL');
    expect(build).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('ready: spawns on the helper with the sanitized spec and the meta verbatim', () => {
    const { route, spawn } = setup();
    const meta = { sessionId: 's1' };
    const inProc = vi.fn(() => 'LOCAL');
    expect(route('claude', () => spec(), meta, inProc)).toBe('REMOTE');
    expect(inProc).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith('claude', spec(), meta);
    expect(spawn.mock.calls[0][2]).toBe(meta);
  });

  it('sanitizes env (undefined, =C:, empty key, NUL value) without mutating the input, and the frame parses', () => {
    const { route, spawn, log } = setup();
    const env = { PATH: 'p', GONE: undefined, '=C:': 'C:\\x', '': 'e', BAD: 'a\0b', 'K\0': 'v', OK: 'ok' };
    const before = { ...env };
    expect(route('terminal2', () => spec({ env }), {}, () => 'LOCAL')).toBe('REMOTE');
    expect(env).toEqual(before);
    const sent = spawn.mock.calls[0][1] as SpecLike;
    expect(sent.env).toEqual({ PATH: 'p', OK: 'ok' });
    expect(parseClientFrame({ t: 'spawn', slot: 'terminal2', spec: sent, meta: {} }, HOME)).not.toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it('env over 32 KiB falls back in-process with one log line', () => {
    const { route, spawn, log } = setup();
    const env = { BIG: 'x'.repeat(40000) };
    expect(route('claude', () => spec({ env }), {}, () => 'LOCAL')).toBe('LOCAL');
    expect(spawn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['cwd', { cwd: 'D:\\elsewhere' }], ['file', { file: 'cmd.exe' }], ['args', { args: ['-x'] }], ['cols', { cols: 0 }],
  ])('a spec the helper would reject (%s) falls back in-process', (_n, over) => {
    const { route, spawn, log } = setup();
    expect(route('claude', () => spec(over as Partial<SpecLike>), {}, () => 'LOCAL')).toBe('LOCAL');
    expect(spawn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('oversized meta falls back in-process', () => {
    const { route, spawn } = setup();
    expect(route('claude', () => spec(), { big: 'x'.repeat(5000) }, () => 'LOCAL')).toBe('LOCAL');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a buildSpec throw propagates', () => {
    const { route } = setup();
    expect(() => route('claude', () => { throw new Error('boom'); }, {}, () => 'LOCAL')).toThrow('boom');
  });
});
