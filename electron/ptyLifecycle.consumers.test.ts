// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, it, expect, vi } from 'vitest';
import { PtyLifecycle, type PtyLike } from './ptyLifecycle';

// Execute the actual main.ts callbacks without importing its Electron/native
// bootstrap. Selection fails loudly if the production wiring is moved/renamed.
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
function callbackFor(channel: string): string {
  const statement = ast.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(ast) === 'ipcMain.handle'
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
  const context = { ptyLifecycle, codexPtyLifecycle, spawnPty, spawnCodexPty, sendToWindow,
    planUsageScraper, communicationSessions: { busy: false }, liveAgentTracker: { notifyPtySpawned: vi.fn() } };
  const compile = (callback: string) => runInNewContext(ts.transpileModule(`(${callback})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context) as (...args: unknown[]) => void;
  return { ...context, event: { sender: { isDestroyed: () => false, send } }, send,
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
