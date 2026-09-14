import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectedFixtureOwnedPids, launchConnectedProduction } from './connectedProductionHelpers';
import { ConnectedCleanupError, cleanupConnectedProduction } from './connectedProductionCleanup';

type Geometry = { cols: number; rows: number; pid: number; sampleId: string };
type NativeEvidence = { writes: string[]; resizes: number[][]; pids: number[]; output: string[] };
type Snapshot = { sessionStatus: { client: string; sessionLabel: string | null } };
const evidence = (app: ElectronApplication) => app.evaluate(({ app }) => Reflect.get(app, '__connectedEvidence') as NativeEvidence);
const snapshot = (page: Page) => page.evaluate(() =>
  (Reflect.get(globalThis.window, 'aetherElectron') as { communication: { snapshot(): Promise<Snapshot> } }).communication.snapshot());
const sidebar = (page: Page, name: string) => page.getByTestId('sidebar-nav').getByRole('button', { name, exact: true }).click();
const size = ({ cols, rows }: Geometry) => ({ cols, rows });

test('built connected replacement inherits fitted native console geometry at unchanged layout', async ({}, testInfo) => {
  test.setTimeout(120000);
  const fixture = await launchConnectedProduction();
  const { app, window, root, command } = fixture;
  const samples: Geometry[] = [];
  const observed = new Set<number>();
  const screens: Record<string, Awaited<ReturnType<ReturnType<Page['locator']>['boundingBox']>>> = {};
  const geometryFile = join(root, 'bin', 'geometry.json');
  let lastSampleId: string | undefined;
  const geometry = async () => {
    command('geometry');
    let receipt: Geometry | undefined;
    await expect.poll(() => {
      if (!existsSync(geometryFile)) return false;
      try { receipt = JSON.parse(readFileSync(geometryFile, 'utf8')) as Geometry; }
      catch { return false; } // File may be observed during its native write.
      return typeof receipt.sampleId === 'string' && receipt.sampleId !== lastSampleId;
    }, { timeout: 10000 }).toBe(true);
    expect(receipt!.cols).toBeGreaterThan(0);
    expect(receipt!.rows).toBeGreaterThan(0);
    expect(receipt!.pid).toBeGreaterThan(0);
    lastSampleId = receipt!.sampleId;
    samples.push(receipt!);
    observed.add(receipt!.pid);
    return receipt!;
  };
  try {
    await sidebar(window, 'Settings');
    await window.getByLabel('Enable Claude–Codex communication').check();
    await window.getByRole('button', { name: 'Start fresh connected Claude', exact: true }).click();
    await expect.poll(async () => (await snapshot(window)).sessionStatus.client, { timeout: 30000 }).toBe('running');
    const firstSession = (await snapshot(window)).sessionStatus.sessionLabel;
    await sidebar(window, 'Terminal');
    await expect(window.locator('.xterm-helper-textarea')).toBeVisible();
    let first: Geometry;
    // Opening Terminal must fit the real console away from its 100x30 spawn default.
    await expect(async () => {
      first = await geometry();
      expect(size(first)).not.toEqual({ cols: 100, rows: 30 });
    }).toPass({ timeout: 10000 });
    await window.screenshot({ path: testInfo.outputPath('geometry-first.png'), animations: 'disabled' });
    screens.first = await window.locator('.xterm-screen').boundingBox();
    expect(screens.first).not.toBeNull();

    // No manual PTY resize or browser size change: only replace from Settings,
    // then return to the same persistent Terminal view and physical layout.
    await sidebar(window, 'Settings');
    await window.getByRole('button', { name: 'Start fresh connected Claude', exact: true }).click();
    await expect.poll(async () => (await snapshot(window)).sessionStatus.sessionLabel, { timeout: 30000 }).not.toBe(firstSession);
    await expect.poll(async () => (await snapshot(window)).sessionStatus.client, { timeout: 30000 }).toBe('running');
    const beforeReturn = await geometry();
    expect(beforeReturn.pid).not.toBe(first!.pid);
    expect.soft(size(beforeReturn), 'replacement console already fits while Settings is open').toEqual(size(first!));
    await sidebar(window, 'Terminal');
    await expect(window.locator('.xterm-helper-textarea')).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath('geometry-replacement.png'), animations: 'disabled' });
    screens.replacement = await window.locator('.xterm-screen').boundingBox();
    expect(screens.replacement).toEqual(screens.first);
    // Poll fresh native samples so a stale receipt cannot masquerade as recovery.
    await expect(async () => {
      const replacement = await geometry();
      expect(replacement.pid).not.toBe(first!.pid);
      expect(size(replacement)).toEqual(size(first!));
    }).toPass({ timeout: 10000 });
  } finally {
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    let nativeEvidence: NativeEvidence | null = null;
    try { nativeEvidence = await evidence(app); } catch { }
    const owned = connectedFixtureOwnedPids(root, [...observed, ...(nativeEvidence?.pids ?? [])]);
    const electronProcess = app.process();
    let cleanupError: unknown;
    try { await cleanupConnectedProduction({
      writeDiagnostics: async () => {
        const path = testInfo.outputPath('native-geometry-evidence.json');
        writeFileSync(path, JSON.stringify({ root, samples, screens, evidence: nativeEvidence, ownedPids: owned.pids }, null, 2));
        await testInfo.attach('native-geometry-evidence', { path, contentType: 'application/json' });
        if (owned.errors.length) throw owned.errors[0];
      },
      requestExit: () => command('exit'), closeApp: () => app.close(),
      forceCloseApp: () => { if (!electronProcess.killed) electronProcess.kill(); },
      ownedPids: owned.pids, isAlive: alive, terminatePid: pid => { process.kill(pid); },
      waitForOwnedExit: async () => {
        await expect.poll(() => owned.pids.filter(alive), { timeout: 5000 }).toEqual([]);
      },
    }); } catch (error) { cleanupError = error; }
    const cleanupPath = testInfo.outputPath('native-geometry-cleanup.json');
    writeFileSync(cleanupPath, JSON.stringify({ ownedPids: owned.pids, alive: owned.pids.filter(alive),
      errors: cleanupError instanceof ConnectedCleanupError ? cleanupError.causes.map(String) : cleanupError ? [String(cleanupError)] : [] }, null, 2));
    await testInfo.attach('native-geometry-cleanup', { path: cleanupPath, contentType: 'application/json' });
    if (cleanupError) throw cleanupError;
  }
});
