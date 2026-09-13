import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanupConnectedProduction } from './connectedProductionCleanup';

// These controls exist only in the fixture's main process.
const control = (app: ElectronApplication, method: string, ...args: unknown[]) =>
  app.evaluate(({ app }, { method, args }) => Reflect.get(app, '__task8')[method](...args), { method, args });
const snapshot = (app: ElectronApplication) => control(app, 'snapshot');
const evidence = (app: ElectronApplication) => control(app, 'evidence');
const tool = (app: ElectronApplication, name: string, args: object) => control(app, 'tool', name, args);
const nav = (page: Page, name: string) => page.getByTestId('sidebar-nav').getByRole('button', { name, exact: true }).click();
// Captured ?1004h enables xterm focus reports: diagnostics observed ESC[O / ESC[I.
// Match the existing native/6C protocol allowlist; never discard arbitrary controls.
const userWrites = (writes: string[]) => writes.filter(value => !/^(?:\x1b\[[?=>]?[\d;]*[cnuRIO]|\x1b\][^\x07]*\x07)+$/.test(value));
async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Fixture operation timed out')), milliseconds);
  })]); } finally { clearTimeout(timer!); }
}

test('combined cross-check: two isolated instances, real clipboard/helper, replacement and delivery', async ({}, testInfo) => {
  test.setTimeout(90000);
  const fixture = resolve('out/e2e-cross-check');
  mkdirSync(fixture, { recursive: true });
  for (const [name, entry] of [['bridge', 'communicationBridge/mainIntegration'], ['ipc', 'communicationBridge/ipc'],
    ['lifecycle', 'ptyLifecycle'], ['observer', 'communicationBridge/connectedPromptObserver']]) {
    buildSync({ entryPoints: [resolve(`electron/${entry}.ts`)], outfile: join(fixture, `${name}.cjs`),
      bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve('package.json')).href) }, logLevel: 'silent' });
  }
  copyFileSync(resolve('e2e/fixtures/cross-check-main.cjs'), join(fixture, 'main.cjs'));
  const apps: ElectronApplication[] = [];
  const outputs: string[] = [];
  try {
    const pages: Page[] = [];
    for (const label of ['A', 'B']) {
      const output = testInfo.outputPath(label); mkdirSync(output, { recursive: true });
      const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
        && !/^(CLAUDE|ELECTRON_|NODE_ENV)/.test(key))) as Record<string, string>;
      Object.assign(env, { AETHER_TEST_REPO: resolve('.'), AETHER_TEST_OUTPUT: output });
      const app = await electron.launch({ args: [join(fixture, 'main.cjs')], env }); apps.push(app); outputs.push(output);
      const page = await app.firstWindow({ timeout: 15000 }); pages.push(page);
      await nav(page, 'Settings');
      await page.getByLabel('Enable Claude–Codex communication').check();
      await page.getByRole('button', { name: 'Start fresh connected Claude', exact: true }).click();
      await expect.poll(async () => (await snapshot(app)).readiness).toBe('ready');
      expect((await evidence(app)).tools).toEqual(['ask_codex', 'cancel_codex_exchange', 'get_codex_exchange']);
    }
    const [a, b] = apps, [pa, pb] = pages;
    const initialA = await snapshot(a), initialB = await snapshot(b);
    expect(initialA.sessionStatus.instanceLabel).not.toBe(initialB.sessionStatus.instanceLabel);
    expect(await a.evaluate(({ app }) => app.getPath('userData')))
      .not.toBe(await b.evaluate(({ app }) => app.getPath('userData')));
    const requests = [];
    for (const [app, page, label] of [[a, pa, 'A'], [b, pb, 'B']] as const) {
      await control(app, 'command', 'prompt');
      await expect(page.getByTestId('communication-client-status')).toContainText('Action required: folder trust');
      await nav(page, 'Comms');
      await page.getByRole('button', { name: 'Cross-check with Codex', exact: true }).click();
      await page.getByLabel('Cross-check question').fill(`TASK8_QUESTION_${label}`);
      await page.getByLabel('Cross-check context').fill(`TASK8_CONTEXT_${label}`);
      await expect(page.getByRole('region', { name: 'Cross-check with Codex' }))
        .toContainText((await snapshot(app)).sessionStatus.instanceLabel);
      const before = await evidence(app), peer = await evidence(app === a ? b : a);
      await page.bringToFront();
      await page.getByRole('button', { name: 'Copy request', exact: true }).click();
      await expect(page.getByText(/^Request copied/)).toBeVisible();
      // Read only content this test just copied; never capture preexisting clipboard content.
      const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
      const payload = copied.match(/<aether_bridge_payload_json>([\s\S]*)<\/aether_bridge_payload_json>$/);
      expect(payload).not.toBeNull(); requests.push(JSON.parse(payload![1]));
      expect(requests.at(-1)).toMatchObject({ question: `TASK8_QUESTION_${label}`, context: `TASK8_CONTEXT_${label}` });
      await page.getByRole('button', { name: 'Focus connected terminal', exact: true }).click();
      await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
      const afterWrites = (await evidence(app)).writes;
      writeFileSync(testInfo.outputPath(`copy-focus-writes-${label}.json`), JSON.stringify({ before: before.writes, after: afterWrites }));
      await testInfo.attach('copy-focus-writes', { body: JSON.stringify({ before: before.writes, after: afterWrites }), contentType: 'application/json' });
      expect(userWrites(afterWrites)).toEqual(userWrites(before.writes));
      expect((await evidence(app)).turns).toBe(0);
      expect(userWrites((await evidence(app === a ? b : a)).writes)).toEqual(userWrites(peer.writes));
      await control(app, 'command', 'clear');
      await expect(page.getByTestId('communication-client-status')).not.toContainText('Action required');
    }
    const accepted = await tool(a, 'ask_codex', requests[0]);
    expect(accepted.exchange_id).toBeTruthy();
    expect((await tool(a, 'ask_codex', requests[0])).exchange_id).toBe(accepted.exchange_id);
    await expect.poll(async () => (await evidence(a)).turns).toBe(1);
    const pending = await tool(a, 'get_codex_exchange', { exchange_id: accepted.exchange_id, wait_ms: 1000 });
    expect(pending.delivery.availability).toBe('pending');
    await control(a, 'complete');
    await expect.poll(async () => (await snapshot(a)).metadata[0]?.delivery.availability).toBe('ready');
    await nav(pa, 'Comms');
    await pa.locator('button[aria-label^="Open communication."]').click();
    await expect(pa.getByText(/TASK8_ANSWER/)).toBeVisible();
    const total = (await snapshot(a)).metadata[0].delivery.totalPages;
    expect(total).toBeGreaterThan(1);
    await expect(pa.getByText(new RegExp(`Claude has been served 0 of ${total} pages`))).toBeVisible();
    const first = await tool(a, 'get_codex_exchange', { exchange_id: accepted.exchange_id });
    await expect(pa.getByText(new RegExp(`Claude has been served 1 of ${total} pages`))).toBeVisible();
    await pa.getByText(new RegExp(`Claude has been served 1 of ${total} pages`)).scrollIntoViewIfNeeded();
    await pa.screenshot({ path: testInfo.outputPath('partial-delivery.png') });
    let answer = first.text, cursor = first.next_cursor;
    const cursors = new Set([first.cursor]);
    while (cursor) {
      expect(cursors.has(cursor)).toBe(false); expect(cursors.size).toBeLessThan(total);
      cursors.add(cursor);
      const page = await tool(a, 'get_codex_exchange', { exchange_id: accepted.exchange_id, cursor });
      expect(page.page_version).toBe(first.page_version);
      answer += page.text; cursor = page.next_cursor;
    }
    expect(answer).toBe('TASK8_ANSWER ' + 'Unicode 😀 "quoted"\\\n'.repeat(1500));
    await expect(pa.getByText(new RegExp(`Claude has been served ${total} of ${total} pages`))).toBeVisible();
    expect((await snapshot(a)).remainingCredits).toBe(2);
    expect((await snapshot(b)).metadata).toEqual([]);
    expect((await snapshot(b)).remainingCredits).toBe(3);
    expect((await tool(b, 'get_codex_exchange', { exchange_id: accepted.exchange_id })).code).toBe('UNKNOWN_EXCHANGE');
    // Composer retains its reviewed session; replacement must demand a review.
    await nav(pa, 'Settings');
    await pa.getByRole('button', { name: 'Start fresh connected Claude', exact: true }).click();
    await expect.poll(async () => (await snapshot(a)).sessionStatus.sessionLabel)
      .not.toBe(initialA.sessionStatus.sessionLabel);
    await expect.poll(async () => (await snapshot(a)).readiness).toBe('ready');
    await control(a, 'command', 'late-old');
    expect((await snapshot(a)).sessionStatus).toMatchObject({ prompt: 'unknown', client: 'running' });
    await pa.getByRole('button', { name: 'Copy request', exact: true }).click();
    await expect(pa.getByText('The launch target changed. Review the current target before copying or focusing.')).toBeVisible();
    expect((await tool(a, 'get_codex_exchange', { exchange_id: accepted.exchange_id })).code).toBe('UNKNOWN_EXCHANGE');
    expect((await snapshot(b)).sessionStatus.sessionLabel).toBe(initialB.sessionStatus.sessionLabel);
    expect((await snapshot(b)).readiness).toBe('ready');
    await control(a, 'command', 'prompt');
    await expect(pa.getByTestId('communication-client-status')).toContainText('Action required: folder trust');
    await control(a, 'command', 'exit');
    await expect(pa.getByTestId('communication-client-status')).toContainText('Client exited');
    await expect(pa.getByTestId('communication-client-status')).not.toContainText('Action required');
    expect((await snapshot(b)).readiness).toBe('ready');
    for (const page of pages) expect(await page.evaluate(() => localStorage.getItem('aetheros-v1'))).not.toContain('TASK8_');
    const evidencePath = testInfo.outputPath('combined-evidence.json');
    writeFileSync(evidencePath, JSON.stringify({ a: await evidence(a), b: await evidence(b),
      limits: 'Two Electron processes and profiles; real clipboard, xterm focus, helper and bridge. Deterministic PTY events/provider. No real Claude, skill invocation, native input delivery, or model probe.' }, null, 2));
    await testInfo.attach('combined-evidence', { path: evidencePath, contentType: 'application/json' });
  } finally {
    const results = await Promise.allSettled(apps.map(async (app, index) => {
      const child = app.process();
      const pids: number[] = child.pid ? [child.pid] : [];
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      await cleanupConnectedProduction({
        writeDiagnostics: () => {
          const inventory = join(outputs[index], 'helper-pids.json');
          if (existsSync(inventory)) {
            const helpers = JSON.parse(readFileSync(inventory, 'utf8'));
            if (!Array.isArray(helpers) || helpers.some(pid => !Number.isInteger(pid) || pid < 1)) throw Error('Invalid helper PID inventory');
            pids.push(...helpers);
          }
        },
        requestExit: () => bounded(control(app, 'stop'), 5000), closeApp: () => app.close(),
        forceCloseApp: () => {
          if (child.pid && alive(child.pid)) {
            if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 4000 });
            else child.kill('SIGKILL');
          }
        },
        ownedPids: pids, isAlive: alive, terminatePid: pid => { process.kill(pid); },
        waitForOwnedExit: async () => { await expect.poll(() => pids.some(alive), { timeout: 5000 }).toBe(false); },
      });
    }));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new Error(`Fixture cleanup failed: ${failures.map(result => result.reason).join('; ')}`);
  }
});
