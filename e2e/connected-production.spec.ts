import { test, expect, type Page, type ElectronApplication } from '@playwright/test';
import { launchConnectedProduction } from './connectedProductionHelpers';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Snapshot = { readiness: string; sessionStatus: { prompt: string; client: string; connected: boolean; sessionLabel: string | null } };
type Bridge = { communication: { snapshot(): Promise<Snapshot>; onSnapshot(cb: (s: Snapshot) => void): () => void };
  pty: { resize(cols: number, rows: number): void } };
const snapshot = (window: Page) => window.evaluate(() => (Reflect.get(globalThis.window, 'aetherElectron') as Bridge).communication.snapshot());
type NativeEvidence = { writes: string[]; resizes: number[][]; pids: number[]; output: string[] };
const evidence = (app: ElectronApplication) => app.evaluate(({ app }) => Reflect.get(app, '__connectedEvidence') as NativeEvidence);
const settings = (window: Page) => window.getByTestId('sidebar-nav').getByRole('button', { name: 'Settings', exact: true }).click();
const resize = (window: Page, cols: number, rows: number) => window.evaluate(({ cols, rows }) => {
  (Reflect.get(globalThis.window, 'aetherElectron') as Bridge).pty.resize(cols, rows);
}, { cols, rows });

test('built production connected native client: readiness, focus, resize, replacement and exit', async ({}, testInfo) => {
  test.setTimeout(120000);
  const fixture = await launchConnectedProduction();
  const { app, window, command } = fixture;
  try {
    await settings(window);
    await window.getByLabel('Enable Claude–Codex communication').check();
    await window.evaluate(() => {
      const history: Snapshot[] = [];
      Reflect.set(globalThis.window, '__snapshotHistory', history);
      (Reflect.get(globalThis.window, 'aetherElectron') as Bridge).communication.onSnapshot(s => history.push(s));
    });
    await window.getByRole('button', { name: 'Start fresh connected Claude', exact: true }).click();
    await expect.poll(async () => (await snapshot(window)).sessionStatus.client, { timeout: 30000 }).toBe('running');
    const first = await snapshot(window);
    const status = window.getByTestId('communication-client-status');
    await expect(status).toContainText('Client not ready');
    command('capture');
    // Captured screen (plus cursor-show) is repainted by ConPTY with implicit wrapping;
    // current matcher intentionally fails closed. This is not real-client
    // compatibility coverage, and the synthetic supported frame is separate.
    await expect.poll(async () => (await evidence(app) as unknown as { output: string[] }).output.join('').includes('Security guide')).toBe(true);
    expect((await snapshot(window)).sessionStatus.prompt).toBe('unknown');
    command('prompt');
    await expect.poll(async () => (await snapshot(window)).sessionStatus.prompt).toBe('folder-trust');
    await expect(status).toContainText('Action required: folder trust');
    await status.screenshot({ path: testInfo.outputPath('folder-trust-dark.png') });
    await window.getByRole('button', { name: 'light', exact: true }).click();
    await expect(status).toContainText('Action required: folder trust');
    await status.screenshot({ path: testInfo.outputPath('folder-trust-light.png') });
    command('clear');
    await expect(status).toContainText('Client not ready');
    await expect(status).not.toContainText('Action required');
    command('prompt');
    await expect(status).toContainText('Action required: folder trust');
    const focus = window.getByRole('button', { name: 'Focus connected terminal', exact: true });
    await focus.focus(); await expect(focus).toBeFocused();
    const before = (await evidence(app)).writes.length;
    await window.keyboard.press('Enter');
    await expect(window.locator('.xterm-helper-textarea')).toBeFocused();
    await expect.poll(async () => (await evidence(app)).output.join(''), { timeout: 10000 })
      .toMatch(/\x1b\[8;\d+;\d+t/);
    await resize(window, 100, 30);
    command('prompt');
    await expect.poll(async () => (await snapshot(window)).sessionStatus.prompt).toBe('folder-trust');
    await expect(status).toContainText('Action required: folder trust');
    await window.screenshot({ path: testInfo.outputPath('focused-terminal-light.png') });
    const writes = (await evidence(app)).writes.slice(before);
    // ConPTY/xterm may reply to device queries. Those are protocol traffic,
    // not acceptance, paste, Enter, or other user-input writes from focus.
    expect(writes.filter(input => !/^(?:\x1b\[[?=>]?[\d;]*[cnuRIO]|\x1b\][^\x07]*\x07)+$/.test(input))).toEqual([]);
    await resize(window, 161, 30);
    await expect(status).toContainText('Client not ready');
    expect((await evidence(app)).resizes).toContainEqual([161, 30]);
    await resize(window, 100, 30); command('prompt');
    await expect.poll(async () => (await snapshot(window)).sessionStatus.prompt).toBe('folder-trust');
    await settings(window);
    command('clear');
    await window.getByRole('button', { name: 'Start fresh connected Claude', exact: true }).click();
    await expect.poll(async () => (await snapshot(window)).sessionStatus.sessionLabel).not.toBe(first.sessionStatus.sessionLabel);
    await expect.poll(async () => (await snapshot(window)).sessionStatus.client, { timeout: 30000 }).toBe('running');
    await expect(status).toContainText('Client not ready');
    command('prompt');
    await expect(status).toContainText('Action required: folder trust');
    command('exit');
    await expect(status).toContainText('Client exited');
    await expect(status).not.toContainText('Action required');
    const finalEvidence = await evidence(app);
    expect(finalEvidence.pids).toHaveLength(2);
    expect(finalEvidence.pids[0]).not.toBe(finalEvidence.pids[1]);
    expect(await app.evaluate((_, pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, finalEvidence.pids[1])).toBe(true);
    const history = await window.evaluate(() => Reflect.get(globalThis.window, '__snapshotHistory') as Snapshot[]);
    expect(history.some(s => s.sessionStatus.prompt === 'folder-trust')).toBe(true);
    expect(history.filter(s => s.sessionStatus.client === 'exited').every(s => s.sessionStatus.prompt === 'unknown')).toBe(true);
    await testInfo.attach('production-path-evidence', { body: JSON.stringify({ root: fixture.root, history, ...finalEvidence }, null, 2), contentType: 'application/json' });
  } finally {
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    let pids: number[] = [];
    try {
      try {
        const nativeEvidence = await evidence(app);
        pids = nativeEvidence.pids;
        const diagnostics = testInfo.outputPath('native-fixture-diagnostics.json');
        writeFileSync(diagnostics, JSON.stringify({ root: fixture.root, evidence: nativeEvidence, snapshot: await snapshot(window) }, null, 2));
        await testInfo.attach('native-fixture-diagnostics', { path: diagnostics, contentType: 'application/json' });
      } finally {
        command('exit');
      }
      const nativePid = Number(readFileSync(join(fixture.root, 'bin/client-pid'), 'utf8'));
      await expect.poll(() => alive(nativePid), { timeout: 5000 }).toBe(false);
    } finally {
      // Even failed diagnostics, early launch or a missing receipt must close
      // Electron and its owned native shells. Preserve failures for the runner.
      await app.close();
      await expect.poll(() => pids.some(alive), { timeout: 5000 }).toBe(false);
    }
  }
});
