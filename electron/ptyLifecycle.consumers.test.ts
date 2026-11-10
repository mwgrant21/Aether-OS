// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, it, expect, vi } from 'vitest';
import type { PtyLike } from './ptyLifecycle';
import { createTerminalHub } from './terminalHub';
import { createDesktopFeed } from './desktopFeed';
import { terminalIdentityEnv } from './ptyManager';
import { createSpawnRouter } from './ptyOwner/spawnRoute';
import { RemotePty } from './ptyOwner/remotePty';
import { ConnectedPromptObserver } from './communicationBridge/connectedPromptObserver';
import capture from './__fixtures__/trust-prompt-capture.json';

// Execute the actual main.ts callbacks without importing its Electron/native
// bootstrap. Selection fails loudly if the production wiring is moved/renamed.
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
function callbackFor(channel: string, method = 'handle'): string {
  const statement = ast.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(ast) === `ipcMain.${method}`
    && node.expression.arguments[0]?.getText(ast) === `'${channel}'`);
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) throw new Error(`Missing ${channel} consumer`);
  return statement.expression.arguments[1].getText(ast);
}
function constFor(name: string): string {
  const statement = ast.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(d => d.name.getText(ast) === name && d.initializer));
  if (!statement || !ts.isVariableStatement(statement)) throw new Error(`Missing top-level const ${name}`);
  return statement.declarationList.declarations.find(d => d.name.getText(ast) === name)!.initializer!.getText(ast);
}
function connectedCallback(option = 'spawn'): string {
  const statement = ast.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(d => d.name.getText(ast) === 'communicationSessions'));
  if (!statement || !ts.isVariableStatement(statement)) throw new Error('Missing connected consumer');
  const init = statement.declarationList.declarations[0].initializer;
  if (!init || !ts.isNewExpression(init) || !init.arguments || !ts.isObjectLiteralExpression(init.arguments[0])) throw new Error('Missing connected options');
  const spawn = init.arguments[0].properties.find(p => p.name?.getText(ast) === option);
  if (!spawn || !ts.isPropertyAssignment(spawn)) throw new Error(`Missing connected ${option}`);
  return spawn.initializer.getText(ast);
}
function fakePty() {
  let data: (value: string) => void = () => {};
  let exit: () => void = () => {};
  return {
    onData: (cb: typeof data) => { data = cb; }, onExit: (cb: typeof exit) => { exit = cb; },
    kill: vi.fn(), write: vi.fn(), resize: vi.fn(),
    fireData: (value: string) => data(value), fireExit: () => exit(),
  } satisfies PtyLike & { fireData(value: string): void; fireExit(): void };
}
const BOARD_CLI = '/fake/aether-board.mjs';
const HOME = 'C:\\Users\\tester';
const fakeSpec = () => ({ file: 'powershell.exe', args: [] as string[], cwd: HOME, env: { PATH: 'x' }, cols: 80, rows: 24, writes: [] as string[] });
// `client` given (even null): the REAL spawn router over it; otherwise spawnOwned is a pass-through to the in-process thunk.
function fixture(opts?: { aetherChoice?: unknown; boardCliPath?: string; client?: { ready: boolean; spawn: ReturnType<typeof vi.fn> } | null }) {
  const hub = createTerminalHub(), ptyLifecycle = hub.slot('claude'), codexPtyLifecycle = hub.slot('codex'), terminal2PtyLifecycle = hub.slot('terminal2');
  const spawnPty = vi.fn(), spawnCodexPty = vi.fn(), send = vi.fn(), sendToWindow = vi.fn();
  const planUsageScraper = { ingest: vi.fn(), reset: vi.fn() };
  // Real feeds (un-gated data goes straight to sendToWindow); reattach is a spy so no hub attach or timer starts.
  const feedFor = (slot: 'claude' | 'codex' | 'terminal2', prefix: string) => {
    const feed = createDesktopFeed({ port: hub.readPort(), slot, send: sendToWindow, channels: { data: prefix + ':data', snap: prefix + ':snap', exit: prefix + ':exit' } });
    return { data: feed.data, exit: feed.exit, reattach: vi.fn() };
  };
  const ptyFeed = feedFor('claude', 'pty'), codexFeed = feedFor('codex', 'codexPty'), terminal2Feed = feedFor('terminal2', 'terminal2Pty');
  let launchId: string | undefined = 'launch-1';
  let prompt = 'unknown';
  const communicationBridge = { currentLaunchId: () => launchId, observePrompt: vi.fn((id: string, value: string) => {
    if (id !== launchId) return false;
    prompt = value; return true;
  }) };
  const connectedPromptObserver = new ConnectedPromptObserver(ptyLifecycle, communicationBridge);
  const context = { communicationBridge, connectedPromptObserver, ptyLifecycle, codexPtyLifecycle, terminal2PtyLifecycle, spawnPty, spawnCodexPty, sendToWindow, ptyFeed, codexFeed, terminal2Feed,
    terminalIdentityEnv, boardCliPath: opts && 'boardCliPath' in opts ? opts.boardCliPath : BOARD_CLI,
    UNMONITORED_TERMINAL_ENV: { AETHER_STATUSLINE_NO_PERSIST: '1' },
    claudeTerminalDimensions: { cols: 100, rows: 30 }, crypto: { randomUUID: () => 'pinned-id' },
    planUsageScraper, communicationSessions: { busy: false }, liveAgentTracker: { notifyPtySpawned: vi.fn() },
    aetherChoice: opts?.aetherChoice ?? null, diagLog: { write: vi.fn() },
    buildPtyLaunchSpec: vi.fn(fakeSpec), buildCodexLaunchSpec: vi.fn(fakeSpec),
    spawnOwned: opts && 'client' in opts
      ? createSpawnRouter({ client: opts.client ?? null, homedir: HOME, log: vi.fn() })
      : vi.fn((_slot: string, _build: unknown, _meta: unknown, inProcess: () => unknown) => inProcess()) };
  const compile = (callback: string) => runInNewContext(ts.transpileModule(`(${callback})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context) as (...args: unknown[]) => void;
  // The start handlers are module-level consts in main.ts; the vm reads these at call time.
  for (const name of ['claudeStartHandlers', 'codexStartHandlers', 'terminal2StartHandlers'])
    Object.assign(context, { [name]: compile(constFor(name)) });
  return { ...context, prompt: () => prompt, launch: (id: string | undefined) => { launchId = id; prompt = 'unknown'; },
    resize: compile(callbackFor('pty:resize', 'on')), event: { sender: { isDestroyed: () => false, send } }, send,
    ordinary: compile(callbackFor('pty:start')), connected: compile(connectedCallback()), codex: compile(callbackFor('codexPty:start')),
    terminal2: compile(callbackFor('terminal2Pty:start')),
    ptyWrite: compile(callbackFor('pty:write', 'on')), terminal2Write: compile(callbackFor('terminal2Pty:write', 'on')) };
}

describe('production terminal consumer ownership (deterministic callbacks)', () => {
  it('declares the three start handler objects as top-level consts in main.ts', () => {
    for (const name of ['claudeStartHandlers', 'codexStartHandlers', 'terminal2StartHandlers'])
      for (const key of ['onData', 'onAlive', 'onExit']) expect(constFor(name)).toContain(`${key}:`);
  });
  it('protects normal and connected Claude rendering and usage from replaced PTYs', () => {
    const f = fixture(), first = fakePty(), second = fakePty(), third = fakePty();
    const secondExit = vi.fn(), thirdExit = vi.fn();
    f.spawnPty.mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(third);
    f.ordinary(f.event, { cols: 80, rows: 24 });
    first.fireData('ordinary');
    f.connected({}, secondExit);
    first.fireData('late ordinary'); first.fireExit();
    second.fireData('connected');
    f.connected({}, thirdExit);
    second.fireData('late connected'); second.fireExit();
    third.fireData('current'); third.fireExit(); third.fireData('after exit');
    expect(f.send).not.toHaveBeenCalled();
    expect(f.sendToWindow.mock.calls.filter(([channel]) => channel === 'pty:data')).toEqual([['pty:data', 'ordinary'], ['pty:data', 'connected'], ['pty:data', 'current']]);
    expect(f.planUsageScraper.ingest.mock.calls).toEqual([['ordinary'], ['connected'], ['current']]);
    expect(f.planUsageScraper.reset).toHaveBeenCalledTimes(1);
    expect(secondExit).not.toHaveBeenCalled(); expect(thirdExit).toHaveBeenCalledTimes(1);
    expect(f.sendToWindow.mock.calls.filter(([channel]) => channel === 'pty:exit')).toHaveLength(1);
    expect(f.ptyLifecycle.current).toBeNull();
  });

  it('a repeated Codex start while live attaches (alive only) instead of killing; a start after exit respawns', () => {
    const f = fixture(), first = fakePty(), second = fakePty();
    f.spawnCodexPty.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const alive = () => f.sendToWindow.mock.calls.filter(([channel]) => channel === 'codexPty:alive').length;
    f.codex(f.event, { cols: 80, rows: 24 }); first.fireData('first');
    expect(alive()).toBe(1);
    f.codex(f.event, { cols: 100, rows: 30 });
    expect(f.spawnCodexPty).toHaveBeenCalledOnce();
    expect(first.kill).not.toHaveBeenCalled();
    expect(f.codexPtyLifecycle.current).toBe(first);
    expect(alive()).toBe(2);
    expect(f.codexFeed.reattach).toHaveBeenCalledOnce();
    first.fireData('still first'); first.fireExit();
    expect(f.codexPtyLifecycle.current).toBeNull();
    f.codex(f.event, { cols: 100, rows: 30 });
    expect(f.spawnCodexPty).toHaveBeenCalledTimes(2);
    expect(f.codexPtyLifecycle.current).toBe(second);
    second.fireData('second'); second.fireExit(); second.fireData('after exit');
    expect(f.sendToWindow.mock.calls.filter(([channel]) => channel === 'codexPty:data')).toEqual([['codexPty:data', 'first'], ['codexPty:data', 'still first'], ['codexPty:data', 'second']]);
    expect(f.sendToWindow.mock.calls.filter(([channel]) => channel === 'codexPty:exit')).toHaveLength(2);
    expect(f.planUsageScraper.ingest).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('a repeated Terminal 2 start while live attaches without spawn, kill or alive; the restarter still respawns after exit', () => {
    const rt = fakeRuntime('CMD\r'), f = fixture({ aetherChoice: rt }), first = fakePty(), second = fakePty();
    f.spawnPty.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const alive = () => f.sendToWindow.mock.calls.filter(([channel]) => channel === 'terminal2Pty:alive').length;
    f.terminal2(f.event, { cols: 80, rows: 24 });
    expect(alive()).toBe(1);
    rt.launchCommandFor.mockClear();
    f.terminal2(f.event, { cols: 100, rows: 30 });
    expect(f.spawnPty).toHaveBeenCalledOnce();
    expect(first.kill).not.toHaveBeenCalled();
    expect(alive()).toBe(1);
    expect(rt.launchCommandFor).not.toHaveBeenCalled();
    expect(rt.onForeignLaunch).not.toHaveBeenCalled();
    expect(f.terminal2Feed.reattach).toHaveBeenCalledOnce();
    first.fireExit();
    f.terminal2PtyLifecycle.write('\r');
    expect(f.spawnPty).toHaveBeenCalledTimes(2);
    expect(f.terminal2PtyLifecycle.current).toBe(second);
  });

  it('a Claude start while live attaches (alive + reattach, no spawn); a first start never reattaches', () => {
    const f = fixture(), first = fakePty();
    f.spawnPty.mockReturnValueOnce(first);
    f.ordinary(f.event, { cols: 80, rows: 24 });
    expect(f.ptyFeed.reattach).not.toHaveBeenCalled();
    f.ordinary(f.event, { cols: 100, rows: 30 });
    expect(f.spawnPty).toHaveBeenCalledOnce();
    expect(f.sendToWindow.mock.calls.filter(([channel]) => channel === 'pty:alive')).toHaveLength(2);
    expect(f.ptyFeed.reattach).toHaveBeenCalledOnce();
  });

  it('a first Codex and Terminal 2 start does not reattach', () => {
    const f = fixture();
    f.spawnPty.mockReturnValueOnce(fakePty());
    f.spawnCodexPty.mockReturnValueOnce(fakePty());
    f.codex(f.event, { cols: 80, rows: 24 }); f.terminal2(f.event, { cols: 80, rows: 24 });
    expect(f.codexFeed.reattach).not.toHaveBeenCalled();
    expect(f.terminal2Feed.reattach).not.toHaveBeenCalled();
  });

  it('routes pty, codexPty and terminal2Pty data through sendToWindow, never the start event sender', () => {
    const f = fixture(), claude = fakePty(), codex = fakePty(), term2 = fakePty();
    f.spawnPty.mockReturnValueOnce(claude).mockReturnValueOnce(term2);
    f.spawnCodexPty.mockReturnValueOnce(codex);
    f.ordinary(f.event, { cols: 80, rows: 24 }); f.codex(f.event, { cols: 80, rows: 24 }); f.terminal2(f.event, { cols: 80, rows: 24 });
    claude.fireData('c'); codex.fireData('x'); term2.fireData('t');
    expect(f.send).not.toHaveBeenCalled();
    expect(f.sendToWindow.mock.calls.filter(([channel]) => String(channel).endsWith(':data')))
      .toEqual([['pty:data', 'c'], ['codexPty:data', 'x'], ['terminal2Pty:data', 't']]);
  });
});

describe('production pinned-session id wiring', () => {
  it('launches the ordinary and connected Claude with the same session id the tracker is told to pin', () => {
    const f = fixture();
    f.spawnPty.mockReturnValueOnce(fakePty()).mockReturnValueOnce(fakePty());
    f.ordinary(f.event, { cols: 80, rows: 24 });
    expect(f.spawnPty).toHaveBeenLastCalledWith(80, 24, undefined, 'pinned-id', { AETHER_TERMINAL: 'alpha', AETHER_BOARD_CLI: BOARD_CLI });
    expect(f.liveAgentTracker.notifyPtySpawned).toHaveBeenLastCalledWith(expect.any(Number), 'pinned-id');
    f.connected({ sessionId: 'connected-id' }, vi.fn());
    expect(f.liveAgentTracker.notifyPtySpawned).toHaveBeenLastCalledWith(expect.any(Number), 'connected-id');
  });

  it('launches Terminal 2 tagged unmonitored, without a session id or touching the pinned tracker', () => {
    const f = fixture();
    f.spawnPty.mockReturnValueOnce(fakePty());
    f.terminal2(f.event, { cols: 80, rows: 24 });
    expect(f.spawnPty).toHaveBeenLastCalledWith(80, 24, undefined, undefined, { AETHER_STATUSLINE_NO_PERSIST: '1', AETHER_TERMINAL: 'beta', AETHER_BOARD_CLI: BOARD_CLI });
    expect(f.liveAgentTracker.notifyPtySpawned).not.toHaveBeenCalled();
  });

  it('launches Alpha with the alpha identity as the only extra env, no launch command', () => {
    const f = fixture();
    f.spawnPty.mockReturnValueOnce(fakePty());
    f.ordinary(f.event, { cols: 80, rows: 24 });
    expect(f.spawnPty.mock.calls[0][4]).toEqual({ AETHER_TERMINAL: 'alpha', AETHER_BOARD_CLI: BOARD_CLI });
    expect(f.spawnPty.mock.calls[0]).toHaveLength(5);
  });

  it('launches Beta with the unmonitored tag merged with the beta identity, not replaced by it', () => {
    const f = fixture();
    f.spawnPty.mockReturnValueOnce(fakePty());
    f.terminal2(f.event, { cols: 80, rows: 24 });
    expect(f.spawnPty.mock.calls[0][4]).toEqual({ AETHER_STATUSLINE_NO_PERSIST: '1', AETHER_TERMINAL: 'beta', AETHER_BOARD_CLI: BOARD_CLI });
  });

  it('omits AETHER_BOARD_CLI for Alpha and Beta when the board CLI file is missing', () => {
    const f = fixture({ boardCliPath: undefined });
    f.spawnPty.mockReturnValueOnce(fakePty()).mockReturnValueOnce(fakePty());
    f.ordinary(f.event, { cols: 80, rows: 24 });
    f.terminal2(f.event, { cols: 80, rows: 24 });
    expect(f.spawnPty.mock.calls[0][4]).not.toHaveProperty('AETHER_BOARD_CLI');
    expect(f.spawnPty.mock.calls[1][4]).not.toHaveProperty('AETHER_BOARD_CLI');
  });

  it('passes the resolved board CLI path into the connected-Claude bridge launch', () => {
    const prepareBridgeLaunch = vi.fn();
    const prepare = runInNewContext(ts.transpileModule(`(${connectedCallback('prepare')})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText, { prepareBridgeLaunch, launchRuntime: {}, launchRoot: 'root', connectedExecutable: 'claude', crypto: { randomUUID: () => 'pinned-id' }, boardCliPath: BOARD_CLI }) as (manifest: unknown) => void;
    prepare({ id: 'm' });
    expect(prepareBridgeLaunch).toHaveBeenCalledWith(expect.objectContaining({ boardCliPath: BOARD_CLI }));
  });

  it('gives the Codex slot no env argument, so it never carries an Alpha/Beta identity', () => {
    const f = fixture();
    f.spawnCodexPty.mockReturnValueOnce(fakePty());
    f.codex(f.event, { cols: 100, rows: 30 });
    expect(f.spawnCodexPty).toHaveBeenLastCalledWith(100, 30);
  });

  it('restarts an exited Terminal 2 through the real handler on a bare Enter, at its last size, still unmonitored', () => {
    const f = fixture(), pty1 = fakePty(), pty2 = fakePty();
    f.spawnPty.mockReturnValueOnce(pty1).mockReturnValueOnce(pty2);
    f.terminal2(f.event, { cols: 80, rows: 24 });
    pty1.fireExit();
    f.terminal2PtyLifecycle.write('\r');
    expect(f.spawnPty).toHaveBeenCalledTimes(2);
    expect(f.spawnPty).toHaveBeenLastCalledWith(80, 24, undefined, undefined, { AETHER_STATUSLINE_NO_PERSIST: '1', AETHER_TERMINAL: 'beta', AETHER_BOARD_CLI: BOARD_CLI });
    expect(f.liveAgentTracker.notifyPtySpawned).not.toHaveBeenCalled();
    pty2.fireData('fresh');
    expect(f.send).not.toHaveBeenCalled();
    expect(f.sendToWindow.mock.calls.filter(([channel]) => channel === 'terminal2Pty:data')).toEqual([['terminal2Pty:data', 'fresh']]);
    expect(f.sendToWindow.mock.calls.filter(([channel]) => channel === 'terminal2Pty:alive')).toHaveLength(2);
    expect(f.sendToWindow.mock.calls.filter(([channel]) => channel === 'terminal2Pty:exit')).toHaveLength(1);
  });

  it('ignores other input on an exited Terminal 2, and a second Enter is a plain write, not a respawn', () => {
    const f = fixture(), pty1 = fakePty(), pty2 = fakePty();
    f.spawnPty.mockReturnValueOnce(pty1).mockReturnValueOnce(pty2);
    f.terminal2(f.event, { cols: 80, rows: 24 });
    pty1.fireExit();
    f.terminal2PtyLifecycle.write('x');
    expect(f.spawnPty).toHaveBeenCalledTimes(1);
    f.terminal2PtyLifecycle.write('\r');
    f.terminal2PtyLifecycle.write('\r');
    expect(f.spawnPty).toHaveBeenCalledTimes(2);
    expect(pty2.write).toHaveBeenCalledWith('\r');
    expect(pty1.write).not.toHaveBeenCalled();
  });
});

const capturedPrompt = capture.chunks.map(chunk => chunk.data).join('');
const redraw = '\x1b[2J\x1b[H' + capture.chunks[capture.chunks.length - 1].data;
function connectedFixture() {
  const f = fixture(), pty = fakePty();
  f.spawnPty.mockReturnValueOnce(pty);
  f.connected({}, vi.fn());
  pty.fireData(capturedPrompt);
  expect(f.prompt()).toBe('folder-trust');
  return { ...f, pty };
}

describe('production connected prompt wiring (deterministic physical PTYs)', () => {
  it('uses connected spawn geometry and never observes ordinary Claude or Codex bytes', () => {
    const f = fixture(), ordinary = fakePty(), codex = fakePty(), connected = fakePty();
    f.spawnPty.mockReturnValueOnce(ordinary).mockReturnValueOnce(connected);
    f.spawnCodexPty.mockReturnValueOnce(codex);
    f.ordinary(f.event, { cols: 80, rows: 24 }); ordinary.fireData(capturedPrompt);
    f.codex(f.event, { cols: 100, rows: 30 }); codex.fireData(capturedPrompt);
    expect(f.communicationBridge.observePrompt).not.toHaveBeenCalled();
    f.connected({}, vi.fn());
    expect(f.spawnPty).toHaveBeenLastCalledWith(80, 24, {});
    connected.fireData(capturedPrompt);
    expect(f.prompt()).toBe('unknown');
    f.resize({}, { cols: 100, rows: 30 }); connected.fireData(redraw);
    expect(f.prompt()).toBe('folder-trust');
  });

  it('retains successful renderer geometry across replacement, failed resize, and ignored ordinary start', () => {
    const f = fixture(), ordinary = fakePty(), connected = fakePty();
    f.spawnPty.mockReturnValueOnce(ordinary).mockReturnValueOnce(connected);
    f.ordinary(f.event, { cols: 80, rows: 24 });
    f.resize({}, { cols: 125, rows: 48 });
    expect(ordinary.resize).toHaveBeenCalledWith(125, 48);
    ordinary.resize.mockImplementationOnce(() => { throw new Error('resize'); });
    expect(() => f.resize({}, { cols: 140, rows: 60 })).toThrow('resize');
    f.resize({}, { cols: 0, rows: 30 });
    f.ordinary(f.event, { cols: 100, rows: 30 });
    expect(f.spawnPty).toHaveBeenCalledOnce();
    f.connected({}, vi.fn());
    expect(f.spawnPty).toHaveBeenLastCalledWith(125, 48, {});
    expect(ordinary.kill).toHaveBeenCalledOnce();
    expect(connected.resize).not.toHaveBeenCalled();
  });

  it.each([false, true])('resets before replacement; old synchronous exit=%s cannot contaminate new evidence', synchronousExit => {
    const f = connectedFixture(), replacement = fakePty(), oldExit = vi.fn();
    f.pty.kill.mockImplementation(() => {
      f.pty.fireData(capturedPrompt);
      if (synchronousExit) f.pty.fireExit();
    });
    f.launch('launch-2');
    f.spawnPty.mockReturnValueOnce(replacement);
    f.connected({}, oldExit);
    expect(f.prompt()).toBe('unknown');
    f.pty.fireData(capturedPrompt); f.pty.fireExit();
    expect(f.prompt()).toBe('unknown');
    replacement.fireData(capturedPrompt); expect(f.prompt()).toBe('folder-trust');
    f.pty.fireExit(); expect(f.prompt()).toBe('folder-trust');
    replacement.fireExit(); expect(f.prompt()).toBe('unknown');
    replacement.fireData(capturedPrompt); expect(f.prompt()).toBe('unknown');
    expect(oldExit).toHaveBeenCalledTimes(1);
  });

  it.each(['spawn', 'cleanup'])('failed replacement %s keeps physical old owner but cannot restore old prompt', failure => {
    const f = connectedFixture(), replacement = fakePty();
    f.launch('launch-2');
    if (failure === 'spawn') f.spawnPty.mockImplementationOnce(() => { throw new Error('spawn'); });
    else {
      f.spawnPty.mockReturnValueOnce(replacement);
      f.pty.kill.mockImplementation(() => { f.pty.fireData(capturedPrompt); throw new Error('cleanup'); });
    }
    expect(() => f.connected({}, vi.fn())).toThrow(failure);
    expect(f.ptyLifecycle.current).toBe(f.pty);
    f.pty.fireData(capturedPrompt); replacement.fireData(capturedPrompt);
    f.resize({}, { cols: 100, rows: 30 }); f.pty.fireData(redraw);
    expect(f.prompt()).toBe('unknown');
    if (failure === 'cleanup') expect(replacement.kill).toHaveBeenCalledOnce();
  });

  it('revocation prevents old physical session data and resize from reasserting a prompt', () => {
    const f = connectedFixture();
    f.launch(undefined);
    f.communicationBridge.observePrompt.mockClear();
    f.pty.fireData(capturedPrompt); f.resize({}, { cols: 100, rows: 30 });
    expect(f.communicationBridge.observePrompt).not.toHaveBeenCalled();
    expect(f.prompt()).toBe('unknown');
    f.pty.fireExit(); expect(f.prompt()).toBe('unknown');
    expect(f.pty.resize).toHaveBeenCalledWith(100, 30);
  });

  it.each([
    ['persistent mode', '\x1b[?6h'],
    ['synchronized output', '\x1b[?2026h'],
    ['unfinished CSI', '\x1b['],
    ['unfinished OSC', '\x1b]8;;hidden'],
    ['erased screen', '\x1b[2J'],
    ['invalidated screen', '\u2603'],
    ['non-prompt repaint', '\x1b[2J\x1b[Hordinary output'],
  ])('positive evidence becomes unknown after %s; history never implies ready', (_name, bytes) => {
    const f = connectedFixture();
    f.pty.fireData(bytes);
    expect(f.prompt()).toBe('unknown');
    expect(f.communicationBridge.observePrompt.mock.calls.every(([, value]) => ['unknown', 'folder-trust'].includes(value))).toBe(true);
  });

  it('resizes before synchronous native output; unsupported geometry cannot confirm', () => {
    const f = connectedFixture();
    f.pty.resize.mockImplementation(() => {
      expect(f.prompt()).toBe('unknown');
      f.pty.fireData(redraw);
    });
    f.resize({}, { cols: 200, rows: 40 }); expect(f.prompt()).toBe('unknown');
    f.resize({}, { cols: 80, rows: 24 }); expect(f.prompt()).toBe('unknown');
    f.resize({}, { cols: 100, rows: 30 }); expect(f.prompt()).toBe('folder-trust');
  });

  it('persistent uncertainty survives resize and erase, and clears only on a fresh physical terminal', () => {
    const f = connectedFixture(), replacement = fakePty();
    f.pty.fireData('\x1b[?6h');
    f.resize({}, { cols: 100, rows: 30 }); f.pty.fireData(redraw);
    expect(f.prompt()).toBe('unknown');
    f.launch('launch-2'); f.spawnPty.mockReturnValueOnce(replacement);
    f.connected({}, vi.fn()); replacement.fireData(capturedPrompt);
    expect(f.prompt()).toBe('folder-trust');
  });

  it('failed native resize stays unknown through repaint until a successful resize', () => {
    const f = connectedFixture();
    f.communicationBridge.observePrompt.mockClear();
    f.pty.resize.mockImplementationOnce(() => { f.pty.fireData(redraw); throw new Error('resize'); });
    expect(() => f.resize({}, { cols: 100, rows: 30 })).toThrow('resize');
    expect(f.communicationBridge.observePrompt.mock.calls.map(([, value]) => value)).toEqual(['unknown', 'unknown']);
    f.pty.fireData(redraw); expect(f.prompt()).toBe('unknown');
    f.resize({}, { cols: 100, rows: 30 }); f.pty.fireData(redraw);
    expect(f.prompt()).toBe('folder-trust');
  });

  it('does not start a physical terminal after launch revocation', () => {
    const f = fixture(); f.launch(undefined);
    expect(() => f.connected({}, vi.fn())).toThrow('REVOKED');
    expect(f.spawnPty).not.toHaveBeenCalled();
  });
});

describe('resize publication transaction ownership', () => {
  it('publishes positive synchronous redraw only after native resize succeeds', () => {
    const f = connectedFixture();
    f.communicationBridge.observePrompt.mockClear();
    f.pty.resize.mockImplementationOnce(() => {
      f.pty.fireData(redraw);
      expect(f.communicationBridge.observePrompt.mock.calls.map(([, value]) => value)).toEqual(['unknown']);
      expect(f.prompt()).toBe('unknown');
    });
    f.resize({}, { cols: 100, rows: 30 });
    expect(f.communicationBridge.observePrompt.mock.calls.map(([, value]) => value)).toEqual(['unknown', 'folder-trust']);
  });

  it.each([false, true])('old native resize throwing=%s cannot suppress or clear a replacement owner', throws => {
    const f = connectedFixture(), replacement = fakePty();
    f.pty.resize.mockImplementationOnce(() => {
      f.launch('launch-2'); f.spawnPty.mockReturnValueOnce(replacement);
      f.connected({}, vi.fn()); replacement.fireData(capturedPrompt);
      expect(f.prompt()).toBe('folder-trust');
      if (throws) throw new Error('old resize');
    });
    if (throws) expect(() => f.resize({}, { cols: 100, rows: 30 })).toThrow('old resize');
    else f.resize({}, { cols: 100, rows: 30 });
    expect(f.prompt()).toBe('folder-trust');
    replacement.fireData(redraw); expect(f.prompt()).toBe('folder-trust');
  });

  it('nested same-owner resize retains unknown geometry until a later independent success', () => {
    const f = connectedFixture();
    f.communicationBridge.observePrompt.mockClear();
    f.pty.resize.mockImplementationOnce(() => {
      f.resize({}, { cols: 100, rows: 30 });
      f.pty.fireData(redraw);
    });
    f.resize({}, { cols: 110, rows: 30 });
    expect(f.communicationBridge.observePrompt.mock.calls.every(([, value]) => value === 'unknown')).toBe(true);
    f.pty.fireData(redraw); expect(f.prompt()).toBe('unknown');
    f.resize({}, { cols: 100, rows: 30 }); f.pty.fireData(redraw);
    expect(f.prompt()).toBe('folder-trust');
  });
});

function fakeRuntime(command: string | undefined) {
  return { launchCommandFor: vi.fn(() => command), onForeignLaunch: vi.fn(), noteUserInput: vi.fn() };
}

describe('AetherChoice host wiring in main.ts (null runtime is a no-op)', () => {
  it('keeps spawn arity with no runtime: 5 args each, no launch command', () => {
    const f = fixture();
    f.spawnPty.mockReturnValueOnce(fakePty()).mockReturnValueOnce(fakePty());
    f.ordinary(f.event, { cols: 80, rows: 24 });
    f.terminal2(f.event, { cols: 80, rows: 24 });
    expect(f.spawnPty.mock.calls[0]).toHaveLength(5);
    expect(f.spawnPty.mock.calls[1]).toHaveLength(5);
  });

  it('passes the launch command as the sixth spawn argument and does not mark it foreign', () => {
    const rt = fakeRuntime('CMD\r'), f = fixture({ aetherChoice: rt });
    f.spawnPty.mockReturnValueOnce(fakePty());
    f.ordinary(f.event, { cols: 80, rows: 24 });
    expect(rt.launchCommandFor).toHaveBeenCalledOnce();
    expect(rt.launchCommandFor).toHaveBeenCalledWith('claude', { sessionId: 'pinned-id' });
    expect(f.spawnPty).toHaveBeenLastCalledWith(80, 24, undefined, 'pinned-id', { AETHER_TERMINAL: 'alpha', AETHER_BOARD_CLI: BOARD_CLI }, 'CMD\r');
    expect(rt.onForeignLaunch).not.toHaveBeenCalled();
  });

  it('does not plan a launch when pty:start finds a live pty (remount)', () => {
    const rt = fakeRuntime('CMD\r'), f = fixture({ aetherChoice: rt });
    f.spawnPty.mockReturnValueOnce(fakePty());
    f.ordinary(f.event, { cols: 80, rows: 24 });
    rt.launchCommandFor.mockClear();
    f.ordinary(f.event, { cols: 80, rows: 24 });
    expect(rt.launchCommandFor).not.toHaveBeenCalled();
    expect(f.spawnPty).toHaveBeenCalledOnce();
    expect(rt.onForeignLaunch).not.toHaveBeenCalled();
  });

  it('launches Terminal 2 with the command, and an Enter restart asks for a new one', () => {
    const rt = fakeRuntime('CMD\r'), f = fixture({ aetherChoice: rt }), pty1 = fakePty(), pty2 = fakePty();
    f.spawnPty.mockReturnValueOnce(pty1).mockReturnValueOnce(pty2);
    f.terminal2(f.event, { cols: 80, rows: 24 });
    expect(rt.launchCommandFor).toHaveBeenLastCalledWith('terminal2');
    expect(f.spawnPty).toHaveBeenLastCalledWith(80, 24, undefined, undefined, { AETHER_STATUSLINE_NO_PERSIST: '1', AETHER_TERMINAL: 'beta', AETHER_BOARD_CLI: BOARD_CLI }, 'CMD\r');
    rt.launchCommandFor.mockReturnValueOnce('CMD2\r');
    pty1.fireExit();
    f.terminal2PtyLifecycle.write('\r');
    expect(rt.launchCommandFor).toHaveBeenCalledTimes(2);
    expect(f.spawnPty).toHaveBeenLastCalledWith(80, 24, undefined, undefined, { AETHER_STATUSLINE_NO_PERSIST: '1', AETHER_TERMINAL: 'beta', AETHER_BOARD_CLI: BOARD_CLI }, 'CMD2\r');
  });

  it('marks a refused launch foreign and keeps the exact legacy args on both slots', () => {
    const rt = fakeRuntime(undefined), f = fixture({ aetherChoice: rt });
    f.spawnPty.mockReturnValueOnce(fakePty()).mockReturnValueOnce(fakePty());
    f.ordinary(f.event, { cols: 80, rows: 24 });
    expect(f.spawnPty.mock.calls[0]).toEqual([80, 24, undefined, 'pinned-id', { AETHER_TERMINAL: 'alpha', AETHER_BOARD_CLI: BOARD_CLI }]);
    expect(rt.onForeignLaunch).toHaveBeenLastCalledWith('claude');
    f.terminal2(f.event, { cols: 80, rows: 24 });
    expect(f.spawnPty.mock.calls[1]).toEqual([80, 24, undefined, undefined, { AETHER_STATUSLINE_NO_PERSIST: '1', AETHER_TERMINAL: 'beta', AETHER_BOARD_CLI: BOARD_CLI }]);
    expect(rt.onForeignLaunch).toHaveBeenLastCalledWith('terminal2');
  });

  it('marks the connected spawn foreign before it spawns', () => {
    const rt = fakeRuntime('CMD\r'), f = fixture({ aetherChoice: rt });
    f.spawnPty.mockReturnValueOnce(fakePty());
    f.connected({}, vi.fn());
    expect(rt.onForeignLaunch).toHaveBeenCalledWith('claude');
    expect(rt.onForeignLaunch.mock.invocationCallOrder[0]).toBeLessThan(f.spawnPty.mock.invocationCallOrder[0]);
  });

  it('drops the stashed plan and rethrows the same error when a managed spawn throws', () => {
    const boom = new Error('boom');
    const rt = fakeRuntime('CMD\r'), f = fixture({ aetherChoice: rt });
    f.spawnPty.mockImplementation(() => { throw boom; });
    expect(() => f.ordinary(f.event, { cols: 80, rows: 24 })).toThrow(boom);
    expect(rt.launchCommandFor).toHaveBeenCalledOnce();
    expect(rt.onForeignLaunch).toHaveBeenCalledOnce();
    expect(rt.onForeignLaunch).toHaveBeenCalledWith('claude');
    expect(rt.onForeignLaunch.mock.invocationCallOrder[0]).toBeGreaterThan(rt.launchCommandFor.mock.invocationCallOrder[0]);
    expect(f.ptyLifecycle.current).toBeNull();
    const rt2 = fakeRuntime('CMD\r'), g = fixture({ aetherChoice: rt2 });
    g.spawnPty.mockImplementation(() => { throw boom; });
    expect(() => g.terminal2(g.event, { cols: 80, rows: 24 })).toThrow(boom);
    expect(rt2.onForeignLaunch).toHaveBeenCalledOnce();
    expect(rt2.onForeignLaunch).toHaveBeenCalledWith('terminal2');
    const h = fixture();
    h.spawnPty.mockImplementation(() => { throw boom; });
    expect(() => h.ordinary(h.event, { cols: 80, rows: 24 })).toThrow(boom);
  });

  it('notes typed input on both write handlers and never on plan:sync', () => {
    const rt = fakeRuntime(undefined), f = fixture({ aetherChoice: rt }), pty1 = fakePty(), pty2 = fakePty();
    f.spawnPty.mockReturnValueOnce(pty1).mockReturnValueOnce(pty2);
    f.ordinary(f.event, { cols: 80, rows: 24 });
    f.terminal2(f.event, { cols: 80, rows: 24 });
    f.ptyWrite({}, 'a');
    f.terminal2Write({}, 'b');
    expect(rt.noteUserInput.mock.calls).toEqual([['claude'], ['terminal2']]);
    expect(pty1.write).toHaveBeenCalledWith('a');
    expect(pty2.write).toHaveBeenCalledWith('b');
    expect(callbackFor('plan:sync')).not.toContain('noteUserInput');
  });

  it('keeps the wiring order: statusline first, launch after the guard, engine port, wrapped phone port, flush in the quit gate', () => {
    const statusline = source.slice(source.indexOf('startStatuslineWatcher(statuslinePayloadPath'));
    expect(statusline.indexOf('onStatusline(')).toBeGreaterThan(-1);
    expect(statusline.indexOf('onStatusline(')).toBeLessThan(statusline.indexOf('isPinnedStatusline('));
    const start = callbackFor('pty:start');
    expect(start.indexOf("launchCommandFor('claude'")).toBeGreaterThan(start.indexOf('ptyLifecycle.current'));
    expect(source).toMatch(/input: aetherChoice \? aetherChoice\.wrapUserWritePort\(terminalHub\.writePort\(\)\)/);
    const engineLine = source.split(/\r?\n/).find(line => /^\s*writePort:/.test(line));
    expect(engineLine).toContain('terminalHub.writePort()');
    expect(engineLine).not.toContain('wrapUserWritePort');
    let gate = '';
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'createFlushQuitGate') gate = node.getText(ast);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(gate).toContain('aetherChoice ? aetherChoice.flush() : Promise.resolve()');
  });
  it.each([['not ready', { ready: false, spawn: vi.fn() }], ['null client', null]])('%s: all three starts call the in-process spawners with today\'s arguments and build no spec', (_n, client) => {
    const f = fixture({ client });
    f.spawnPty.mockReturnValue(fakePty()); f.spawnCodexPty.mockReturnValue(fakePty());
    f.ordinary(f.event, { cols: 80, rows: 24 });
    f.codex(f.event, { cols: 90, rows: 25 });
    f.terminal2(f.event, { cols: 70, rows: 20 });
    expect(f.spawnPty.mock.calls).toEqual([
      [80, 24, undefined, 'pinned-id', { AETHER_TERMINAL: 'alpha', AETHER_BOARD_CLI: BOARD_CLI }],
      [70, 20, undefined, undefined, { AETHER_STATUSLINE_NO_PERSIST: '1', AETHER_TERMINAL: 'beta', AETHER_BOARD_CLI: BOARD_CLI }],
    ]);
    expect(f.spawnCodexPty.mock.calls).toEqual([[90, 25]]);
    expect(f.buildPtyLaunchSpec).not.toHaveBeenCalled();
    expect(f.buildCodexLaunchSpec).not.toHaveBeenCalled();
    if (client) expect(client.spawn).not.toHaveBeenCalled();
  });

  it('ready client: all three starts go to the helper (slot + meta), wire the RemotePty into the lifecycle, and never spawn in-process', () => {
    const remote = { claude: fakePty(), codex: fakePty(), terminal2: fakePty() };
    const client = { ready: true, spawn: vi.fn((slot: 'claude' | 'codex' | 'terminal2', _spec?: unknown, _meta?: unknown) => remote[slot]) };
    const f = fixture({ client });
    f.ordinary(f.event, { cols: 80, rows: 24 });
    f.codex(f.event, { cols: 90, rows: 25 });
    f.terminal2(f.event, { cols: 70, rows: 20 });
    expect(client.spawn.mock.calls.map(c => c[0])).toEqual(['claude', 'codex', 'terminal2']);
    expect(client.spawn.mock.calls[0][2]).toMatchObject({ kind: 'claude', sessionId: 'pinned-id' });
    expect(client.spawn.mock.calls[1][2]).toMatchObject({ kind: 'codex' });
    expect(client.spawn.mock.calls[2][2]).toMatchObject({ kind: 'terminal2' });
    expect(f.spawnPty).not.toHaveBeenCalled();
    expect(f.spawnCodexPty).not.toHaveBeenCalled();
    expect(f.ptyLifecycle.current).toBe(remote.claude);
    expect(f.codexPtyLifecycle.current).toBe(remote.codex);
    expect(f.terminal2PtyLifecycle.current).toBe(remote.terminal2);
    remote.claude.fireData('from helper');
    expect(f.sendToWindow).toHaveBeenCalledWith('pty:data', 'from helper');
  });

  it('ready client with the real RemotePty: fresh starts deliver helper output and exit to the renderer (resume after wiring)', () => {
    const links: Record<string, { sent: unknown[] }> = {};
    const remote: Record<string, RemotePty> = {};
    const client = { ready: true, spawn: vi.fn((slot: 'claude' | 'codex' | 'terminal2') => {
      links[slot] = { sent: [] };
      return (remote[slot] = new RemotePty(slot, { send: f => { links[slot].sent.push(f); return true; }, dead: () => false }));
    }) };
    const f = fixture({ client });
    f.ordinary(f.event, { cols: 80, rows: 24 });
    f.codex(f.event, { cols: 90, rows: 25 });
    f.terminal2(f.event, { cols: 70, rows: 20 });
    for (const [slot, prefix] of [['claude', 'pty'], ['codex', 'codexPty'], ['terminal2', 'terminal2Pty']] as const) {
      remote[slot].deliver(1, 'from ' + slot);
      expect(f.sendToWindow).toHaveBeenCalledWith(prefix + ':data', 'from ' + slot);
      remote[slot].deliverExit();
      expect(f.sendToWindow).toHaveBeenCalledWith(prefix + ':exit', undefined);
    }
  });

  it('ready client: the connected-session spawn stays in-process', () => {
    const client = { ready: true, spawn: vi.fn() };
    const f = fixture({ client });
    f.spawnPty.mockReturnValueOnce(fakePty());
    f.connected({}, vi.fn());
    expect(f.spawnPty).toHaveBeenCalledOnce();
    expect(client.spawn).not.toHaveBeenCalled();
  });

  it('pins the quit policy: shutdown, owner frame first in the held-quit flush, quitting set before it', () => {
    expect(constFor('PTY_OWNER_ON_QUIT')).toBe("'shutdown'");
    let gate = '';
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'createFlushQuitGate') gate = node.getText(ast);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    const flag = gate.indexOf('quitting = true'), frame = gate.indexOf('ownerClient.shutdown()');
    expect(flag).toBeGreaterThan(-1);
    expect(frame).toBeGreaterThan(flag);
    expect(gate.indexOf('PTY_OWNER_ON_QUIT')).toBeGreaterThan(-1);
    expect(frame).toBeLessThan(gate.indexOf('narrationDurationBaseline.flush()'));
  });

  it('guards the helper launch with quitting and the feature with AETHER_PTY_OWNER=1 on win32', () => {
    const adopt = source.slice(source.indexOf('async function adoptAtStartup'), source.indexOf('const claudeStartHandlers'));
    expect(adopt).toMatch(/if \(quitting\) return;\s+const ok = await ensureOwner/);
    expect(adopt).toContain("if (quitting) throw new Error('quitting')");
    expect(constFor('ptyOwnerEnabled')).toBe("process.platform === 'win32' && process.env.AETHER_PTY_OWNER === '1'");
  });

  describe('adoptAtStartup (executed)', () => {
    function functionFor(name: string): string {
      const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.getText(ast) === name);
      if (!fn) throw new Error(`Missing top-level function ${name}`);
      return fn.getText(ast);
    }
    // Hand-built sandbox for every free identifier adoptAtStartup reads; `quitting` and the claude apply targets live on it.
    function adoptFixture(opts: { quitting?: boolean; policy?: 'shutdown' | 'release'; ok?: boolean; quitDuringWait?: boolean } = {}) {
      const ownerClient = { shutdown: vi.fn(async () => {}), release: vi.fn(async () => {}) };
      const lifecycle = () => ({ start: vi.fn() });
      const sandbox: Record<string, unknown> = {
        ownerClient, quitting: opts.quitting ?? false, PTY_OWNER_ON_QUIT: opts.policy ?? 'shutdown',
        ensureOwner: vi.fn(async () => { if (opts.quitDuringWait) sandbox.quitting = true; return opts.ok ?? true; }),
        adoptOwned: vi.fn(async () => {}), ownerLog: vi.fn(),
        join: (...p: string[]) => p.join('/'), aetherOsDir: 'aos', discoveryFileName: () => 'd.json', PROTO: 1,
        app: { getPath: () => 'ud' }, __dirname: 'dir', existsSync: vi.fn(), readFileSync: vi.fn(), rmSync: vi.fn(),
        spawnChild: vi.fn(), pidIsAlive: vi.fn(), process: { execPath: 'node', env: {} },
        ptyLifecycle: lifecycle(), codexPtyLifecycle: lifecycle(), terminal2PtyLifecycle: lifecycle(),
        claudeStartHandlers: {}, codexStartHandlers: {}, terminal2StartHandlers: {},
        claudeTerminalDimensions: null, pinnedPtyExited: true, pinnedLaunchSessionId: undefined,
        liveAgentTracker: { notifyPtySpawned: vi.fn() },
      };
      const run = runInNewContext(ts.transpileModule(`(${functionFor('adoptAtStartup')})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText, sandbox) as () => Promise<void>;
      const adopted = () => (sandbox.adoptOwned as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        targets: Record<'claude' | 'codex' | 'terminal2', { start(pty: unknown, info: { cols: number; rows: number }): void; apply(info: unknown): void }>;
      };
      return { sandbox, ownerClient, run, adopted };
    }
    const claudeInfo = (meta: Record<string, unknown>) => ({ cols: 90, rows: 33, meta, startedAt: 999 });

    it('quit during the launch wait with policy shutdown shuts the helper down and adopts nothing', async () => {
      const f = adoptFixture({ quitDuringWait: true });
      await f.run();
      expect(f.ownerClient.shutdown).toHaveBeenCalledOnce();
      expect(f.ownerClient.release).not.toHaveBeenCalled();
      expect(f.sandbox.adoptOwned).not.toHaveBeenCalled();
      expect(f.sandbox.ownerLog).not.toHaveBeenCalledWith('pty-owner: adoption failed');
    });

    it('quit during the launch wait with policy release releases instead, so live shells survive', async () => {
      const f = adoptFixture({ quitDuringWait: true, policy: 'release' });
      await f.run();
      expect(f.ownerClient.release).toHaveBeenCalledOnce();
      expect(f.ownerClient.shutdown).not.toHaveBeenCalled();
      expect(f.sandbox.adoptOwned).not.toHaveBeenCalled();
      expect(f.sandbox.ownerLog).not.toHaveBeenCalledWith('pty-owner: adoption failed');
    });

    it('does nothing to the helper when ensureOwner holds no connected client, even while quitting', async () => {
      const f = adoptFixture({ quitDuringWait: true, ok: false });
      await f.run();
      expect(f.ownerClient.shutdown).not.toHaveBeenCalled();
      expect(f.ownerClient.release).not.toHaveBeenCalled();
      expect(f.sandbox.adoptOwned).not.toHaveBeenCalled();
      expect(f.sandbox.ownerLog).not.toHaveBeenCalledWith('pty-owner: adoption failed');
    });

    it('adopts with claude/codex/terminal2 targets and the claude apply sets dimensions, pin state and tracker', async () => {
      const f = adoptFixture();
      await f.run();
      expect(f.sandbox.adoptOwned).toHaveBeenCalledOnce();
      expect(f.sandbox.ownerLog).not.toHaveBeenCalledWith('pty-owner: adoption failed');
      expect(f.ownerClient.shutdown).not.toHaveBeenCalled();
      expect(Object.keys(f.adopted().targets).sort()).toEqual(['claude', 'codex', 'terminal2']);
      f.adopted().targets.claude.apply(claudeInfo({ sessionId: 'sid', startedAt: 555 }));
      expect(f.sandbox.claudeTerminalDimensions).toEqual({ cols: 90, rows: 33 });
      expect(f.sandbox.pinnedPtyExited).toBe(false);
      expect(f.sandbox.pinnedLaunchSessionId).toBe('sid');
      expect((f.sandbox.liveAgentTracker as { notifyPtySpawned: ReturnType<typeof vi.fn> }).notifyPtySpawned).toHaveBeenCalledWith(555, 'sid');
    });

    it('claude apply without a session id or numeric startedAt pins null and falls back to the adopted startedAt', async () => {
      const f = adoptFixture();
      await f.run();
      f.adopted().targets.claude.apply(claudeInfo({ startedAt: '555' }));
      expect(f.sandbox.pinnedLaunchSessionId).toBeNull();
      expect((f.sandbox.liveAgentTracker as { notifyPtySpawned: ReturnType<typeof vi.fn> }).notifyPtySpawned).toHaveBeenCalledWith(999, null);
    });

    it('target start forwards cols/rows with { adopted: true }; codex and terminal2 apply is a no-op', async () => {
      const f = adoptFixture();
      await f.run();
      const pty = fakePty();
      f.adopted().targets.claude.start(pty, { cols: 90, rows: 33 });
      const start = (f.sandbox.ptyLifecycle as { start: ReturnType<typeof vi.fn> }).start;
      expect(start).toHaveBeenCalledOnce();
      expect(start.mock.calls[0][0]()).toBe(pty);
      expect(start.mock.calls[0][2]).toEqual({ cols: 90, rows: 33 });
      expect(start.mock.calls[0][3]).toEqual({ adopted: true });
      f.adopted().targets.codex.apply(claudeInfo({ sessionId: 'sid', startedAt: 555 }));
      f.adopted().targets.terminal2.apply(claudeInfo({ sessionId: 'sid', startedAt: 555 }));
      expect((f.sandbox.liveAgentTracker as { notifyPtySpawned: ReturnType<typeof vi.fn> }).notifyPtySpawned).not.toHaveBeenCalled();
      expect(f.sandbox.pinnedPtyExited).toBe(true);
    });
  });

  it.each([[undefined, true], ['EPERM', true], ['ESRCH', false], ['EINVAL', false]])('pidIsAlive: kill error %s -> alive=%s', (code, alive) => {
    const kill = vi.fn(() => { if (code) throw Object.assign(new Error('x'), { code }); return true; });
    const isAlive = runInNewContext(ts.transpileModule(`(${constFor('pidIsAlive')})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText, { process: { kill } }) as (pid: number) => boolean;
    expect(isAlive(42)).toBe(alive);
    expect(kill).toHaveBeenCalledWith(42, 0);
  });

});
