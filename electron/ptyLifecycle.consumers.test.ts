// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, it, expect, vi } from 'vitest';
import { PtyLifecycle, type PtyLike } from './ptyLifecycle';
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
function connectedCallback(): string {
  const statement = ast.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(d => d.name.getText(ast) === 'communicationSessions'));
  if (!statement || !ts.isVariableStatement(statement)) throw new Error('Missing connected consumer');
  const init = statement.declarationList.declarations[0].initializer;
  if (!init || !ts.isNewExpression(init) || !init.arguments || !ts.isObjectLiteralExpression(init.arguments[0])) throw new Error('Missing connected options');
  const spawn = init.arguments[0].properties.find(p => p.name?.getText(ast) === 'spawn');
  if (!spawn || !ts.isPropertyAssignment(spawn)) throw new Error('Missing connected spawn');
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
function fixture() {
  const ptyLifecycle = new PtyLifecycle(), codexPtyLifecycle = new PtyLifecycle();
  const spawnPty = vi.fn(), spawnCodexPty = vi.fn(), send = vi.fn(), sendToWindow = vi.fn();
  const planUsageScraper = { ingest: vi.fn(), reset: vi.fn() };
  let launchId: string | undefined = 'launch-1';
  let prompt = 'unknown';
  const communicationBridge = { currentLaunchId: () => launchId, observePrompt: vi.fn((id: string, value: string) => {
    if (id !== launchId) return false;
    prompt = value; return true;
  }) };
  const connectedPromptObserver = new ConnectedPromptObserver(ptyLifecycle, communicationBridge);
  const context = { communicationBridge, connectedPromptObserver, ptyLifecycle, codexPtyLifecycle, spawnPty, spawnCodexPty, sendToWindow,
    planUsageScraper, communicationSessions: { busy: false }, liveAgentTracker: { notifyPtySpawned: vi.fn() } };
  const compile = (callback: string) => runInNewContext(ts.transpileModule(`(${callback})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context) as (...args: unknown[]) => void;
  return { ...context, prompt: () => prompt, launch: (id: string | undefined) => { launchId = id; prompt = 'unknown'; },
    resize: compile(callbackFor('pty:resize', 'on')), event: { sender: { isDestroyed: () => false, send } }, send,
    ordinary: compile(callbackFor('pty:start')), connected: compile(connectedCallback()), codex: compile(callbackFor('codexPty:start')) };
}

describe('production terminal consumer ownership (deterministic callbacks)', () => {
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
    expect(f.send.mock.calls).toEqual([['pty:data', 'ordinary']]);
    expect(f.sendToWindow.mock.calls.filter(([channel]) => channel === 'pty:data')).toEqual([['pty:data', 'connected'], ['pty:data', 'current']]);
    expect(f.planUsageScraper.ingest.mock.calls).toEqual([['ordinary'], ['connected'], ['current']]);
    expect(f.planUsageScraper.reset).toHaveBeenCalledTimes(1);
    expect(secondExit).not.toHaveBeenCalled(); expect(thirdExit).toHaveBeenCalledTimes(1);
    expect(f.sendToWindow.mock.calls.filter(([channel]) => channel === 'pty:exit')).toHaveLength(1);
    expect(f.ptyLifecycle.current).toBeNull();
  });

  it('repeated Codex start replaces directly and suppresses superseded data and exit', () => {
    const f = fixture(), first = fakePty(), second = fakePty();
    f.spawnCodexPty.mockReturnValueOnce(first).mockReturnValueOnce(second);
    f.codex(f.event, { cols: 80, rows: 24 }); first.fireData('first');
    f.codex(f.event, { cols: 100, rows: 30 });
    expect(first.kill).toHaveBeenCalledTimes(1);
    expect(f.codexPtyLifecycle.current).toBe(second);
    first.fireData('late'); first.fireExit();
    expect(f.sendToWindow.mock.calls.filter(([channel]) => channel === 'codexPty:exit')).toHaveLength(0);
    second.fireData('second'); second.fireExit(); second.fireData('after exit');
    expect(f.send.mock.calls).toEqual([['codexPty:data', 'first'], ['codexPty:data', 'second']]);
    expect(f.sendToWindow.mock.calls.filter(([channel]) => channel === 'codexPty:alive')).toHaveLength(2);
    expect(f.sendToWindow.mock.calls.filter(([channel]) => channel === 'codexPty:exit')).toHaveLength(1);
    expect(f.planUsageScraper.ingest).not.toHaveBeenCalled();
    expect(f.ptyLifecycle.current).toBeNull(); expect(f.codexPtyLifecycle.current).toBeNull();
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
    expect(f.spawnPty).toHaveBeenLastCalledWith(100, 30, {});
    connected.fireData(capturedPrompt);
    expect(f.prompt()).toBe('folder-trust');
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
