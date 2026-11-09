import { describe, expect, it, vi } from 'vitest';
import { ensureOwner, minimalHelperEnv, type EnsureOwnerDeps } from './ownerLauncher';
import { encodeDiscovery, newSecret } from './protocol';

const DISC = 'C:\\tmp\\d.json';
const discText = (pid: number): string =>
  encodeDiscovery({ v: 1, pipe: '\\\\.\\pipe\\aether-pty-owner-abc', pid, startedAt: 1, secret: newSecret() });

function rig(o: { files?: Map<string, string>; connect?: (n: number) => Promise<void>; alive?: boolean; appearAfter?: number } = {}) {
  const files = o.files ?? new Map<string, string>();
  let connects = 0;
  const client = {
    ready: false,
    connect: vi.fn(async () => { connects++; await (o.connect ? o.connect(connects) : Promise.resolve()); client.ready = true; }),
  };
  const handlers: Record<string, (e: Error) => void> = {};
  const child = { on: vi.fn((ev: string, cb: (e: Error) => void) => { handlers[ev] = cb; }), unref: vi.fn() };
  const spawn = vi.fn((..._a: unknown[]) => child);
  let t = 0;
  let polls = 0;
  const deps: EnsureOwnerDeps = {
    client, discoveryPath: DISC, execPath: 'C:\\node.exe', entryPath: 'C:\\out\\main\\pty-owner.js',
    spawn,
    fs: {
      existsSync: (p) => files.has(p),
      readFileSync: (p) => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v; },
      rmSync: vi.fn((p: string) => { files.delete(p); }),
    },
    isAlive: () => o.alive ?? false,
    env: { PATH: 'p', ANTHROPIC_API_KEY: 'secret' },
    sleep: async (ms) => { t += ms; polls++; if (o.appearAfter !== undefined && polls >= o.appearAfter) files.set(DISC, discText(4242)); },
    now: () => t,
    log: vi.fn(),
  };
  return { deps, client, spawn, child, handlers, files };
}
const failWith = (m: string) => Promise.reject(new Error(m));

describe('ensureOwner', () => {
  it('fresh launch: spawns once with exact options, waits for the file, connects', async () => {
    const r = rig({ appearAfter: 3 });
    expect(await ensureOwner(r.deps)).toBe(true);
    expect(r.spawn).toHaveBeenCalledTimes(1);
    const [file, args, opts] = r.spawn.mock.calls[0] as unknown as [string, string[], unknown];
    expect(file).toBe('C:\\node.exe');
    expect(args).toEqual(['C:\\out\\main\\pty-owner.js']);
    expect(opts).toEqual({
      detached: true, stdio: 'ignore', windowsHide: true,
      env: minimalHelperEnv(r.deps.env, { discoveryPath: DISC }),
    });
    expect(r.child.unref).toHaveBeenCalled();
    expect(r.client.connect).toHaveBeenCalledWith(DISC);
  });

  it('reuses a live helper without spawning', async () => {
    const r = rig({ files: new Map([[DISC, discText(1)]]) });
    expect(await ensureOwner(r.deps)).toBe(true);
    expect(r.spawn).not.toHaveBeenCalled();
  });

  it('removes a stale file (closed + dead pid) then relaunches', async () => {
    const files = new Map([[DISC, discText(77)]]);
    const r = rig({ files, connect: (n) => (n === 1 ? failWith('closed') : Promise.resolve()), alive: false, appearAfter: 1 });
    expect(await ensureOwner(r.deps)).toBe(true);
    expect(r.deps.fs.rmSync).toHaveBeenCalledWith(DISC, { force: true });
    expect(r.spawn).toHaveBeenCalledTimes(1);
  });

  it('treats an undecodable file as stale when the connect failed', async () => {
    const r = rig({
      files: new Map([[DISC, 'garbage']]),
      connect: (n) => (n === 1 ? failWith('bad discovery file') : Promise.resolve()), appearAfter: 1,
    });
    expect(await ensureOwner(r.deps)).toBe(true);
    expect(r.deps.fs.rmSync).toHaveBeenCalledTimes(1);
  });

  for (const msg of ['busy', 'bad proof', 'timeout']) {
    it(`'${msg}' returns false, keeps the file, never launches`, async () => {
      const r = rig({ files: new Map([[DISC, discText(77)]]), connect: () => failWith(msg), alive: false });
      expect(await ensureOwner(r.deps)).toBe(false);
      expect(r.files.has(DISC)).toBe(true);
      expect(r.deps.fs.rmSync).not.toHaveBeenCalled();
      expect(r.spawn).not.toHaveBeenCalled();
    });
  }

  it('closed with a live pid returns false, keeps the file, never launches', async () => {
    const r = rig({ files: new Map([[DISC, discText(77)]]), connect: () => failWith('closed'), alive: true });
    expect(await ensureOwner(r.deps)).toBe(false);
    expect(r.files.has(DISC)).toBe(true);
    expect(r.deps.fs.rmSync).not.toHaveBeenCalled();
    expect(r.spawn).not.toHaveBeenCalled();
  });

  it('gives up within launchWaitMs when the file never appears', async () => {
    const r = rig();
    r.deps.launchWaitMs = 500;
    expect(await ensureOwner(r.deps)).toBe(false);
    expect(r.client.connect).not.toHaveBeenCalled();
  });

  it('a child error event does not throw; a throwing spawn returns false', async () => {
    const r = rig({ appearAfter: 1 });
    expect(await ensureOwner(r.deps)).toBe(true);
    expect(() => r.handlers.error(new Error('ENOENT'))).not.toThrow();
    r.spawn.mockImplementation(() => { throw new Error('boom'); });
    r.client.ready = false;
    expect(await ensureOwner({ ...r.deps, fs: { ...r.deps.fs, existsSync: () => false } })).toBe(false);
  });
});

describe('minimalHelperEnv', () => {
  it('leaks nothing outside the allowlist and sets the helper vars', () => {
    const env = minimalHelperEnv({
      ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', CODEX_HOME: 'c', AETHER_CHOICE_HOST: '1', FOO: 'f',
      ELECTRON_RUN_AS_NODE: '0', SystemRoot: 'C:\\Windows', PATH: 'p',
    }, { discoveryPath: DISC });
    expect(env).toEqual({
      ELECTRON_RUN_AS_NODE: '1', AETHER_PTY_OWNER_DISCOVERY: DISC, AETHER_PTY_OWNER_GRACE_MS: '900000',
      SystemRoot: 'C:\\Windows', PATH: 'p',
    });
  });
  it('honours valid grace/idle and ignores invalid ones', () => {
    expect(minimalHelperEnv({ AETHER_PTY_OWNER_GRACE_MS: '1000', AETHER_PTY_OWNER_IDLE_MS: '50' }, { discoveryPath: DISC }))
      .toMatchObject({ AETHER_PTY_OWNER_GRACE_MS: '1000', AETHER_PTY_OWNER_IDLE_MS: '50' });
    const bad = minimalHelperEnv({ AETHER_PTY_OWNER_GRACE_MS: '-1', AETHER_PTY_OWNER_IDLE_MS: 'x' }, { discoveryPath: DISC });
    expect(bad.AETHER_PTY_OWNER_GRACE_MS).toBe('900000');
    expect('AETHER_PTY_OWNER_IDLE_MS' in bad).toBe(false);
  });
});
