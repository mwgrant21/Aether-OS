import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { launchApp } from './electronHelpers';

/**
 * Read the sidebar's tab ids out of viewRegistry.ts's source rather than
 * hardcoding them. A hardcoded list silently stops covering new views: before
 * issue #21 this array named 10 of the registry's 14, so Codex -- the newest
 * view at the time -- was never smoke-tested at all.
 *
 * The registry is parsed as text, not imported, because importing it would
 * pull every React view component into the Playwright process.
 */
function sidebarTabsFromRegistry(): string[] {
  const src = readFileSync(new URL('../src/viewRegistry.ts', import.meta.url), 'utf-8');
  const tabs: string[] = [];
  const re = /\{\s*id:\s*'([^']+)',\s*inSidebar:\s*true\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) tabs.push(m[1]);
  if (tabs.length === 0) throw new Error('parsed no sidebar tabs from viewRegistry.ts -- has its shape changed?');
  return tabs;
}

const SIDEBAR_TABS = sidebarTabsFromRegistry();

test.describe('Aether OS smoke', () => {
  test('launches without crashing', async () => {
    const { app, window } = await launchApp();
    try {
      await expect(window.locator('body')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('every sidebar tab renders its view with no console errors', async () => {
    const { app, window } = await launchApp();
    try {
      const consoleErrors: string[] = [];
      window.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      const sidebarNav = window.locator('[data-testid="sidebar-nav"]');
      for (const tab of SIDEBAR_TABS) {
        await sidebarNav.getByRole('button', { name: tab, exact: true }).click();
        await window.waitForTimeout(200);
      }

      expect(consoleErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('the embedded terminal spawns a real pty and renders real output', async () => {
    // The native PTY and production IPC are real; launchApp places harmless CLIs on PATH.
    const { app, window } = await launchApp();
    try {
      await window.locator('[data-testid="sidebar-nav"]').getByRole('button', { name: 'Terminal', exact: true }).click();
      await window.locator('.xterm-screen').waitFor({ state: 'visible', timeout: 10000 });

      // Assert on .xterm-rows, NOT .xterm-screen. xterm's DOM renderer injects its own
      // <style> block INSIDE .xterm-screen, so that element's textContent is tens of
      // thousands of characters of CSS before the pty writes a single byte -- a length
      // assertion against it passes whether or not the terminal ever produced output.
      // Measured live while fixing issue #21: with pty output, .xterm-screen is 56,039
      // chars and .xterm-rows 826; with the rendered rows stripped, .xterm-screen is
      // still 55,212 while .xterm-rows drops to 0. Only .xterm-rows responds to the
      // fact this test exists to prove.
      const xtermRows = window.locator('.xterm-rows');
      await expect(async () => {
        const text = (await xtermRows.textContent())?.trim() ?? '';
        expect(text).toContain('AETHER_E2E_CLAUDE_FIXTURE_REAL_PTY_NO_MODEL');
      }).toPass({ timeout: 10000 });
    } finally {
      await app.close();
    }
  });

  test('the Codex terminal delivers real output after repeated start', async () => {
    const { app, window } = await launchApp();
    try {
      // Exercise the actual production IPC consumer twice. The isolated helper
      // resolves codex to a harmless fixture; neither start invokes a model.
      const results = await window.evaluate(async () => {
        const api = window.aetherElectron!.codexPty;
        const startAndObserve = () => new Promise<{ output: string; pid: number }>((resolve, reject) => {
          let output = '';
          const timer = setTimeout(() => { unsubscribe(); reject(new Error('Codex PTY output timed out')); }, 10000);
          const unsubscribe = api.onData(data => {
            output += data;
            const pid = /AETHER_CODEX_PID=(\d+)(?:\r?\n)/.exec(output);
            if (pid && output.includes('AETHER_E2E_CODEX_FIXTURE_REAL_PTY_NO_MODEL')) {
              clearTimeout(timer); unsubscribe(); resolve({ output, pid: Number(pid[1]) });
            }
          });
          api.start({ cols: 100, rows: 30 }).then(() => {
            // Split the marker so terminal echo cannot satisfy the output assertion.
            api.write("Write-Output ('AETHER_CODEX_' + 'PID=' + $PID)\r");
          }).catch(error => {
            clearTimeout(timer); unsubscribe(); reject(error);
          });
        });
        const first = await startAndObserve();
        const replacement = await startAndObserve();
        return { first, replacement };
      });
      expect(results.first.output).toContain('AETHER_E2E_CODEX_FIXTURE_REAL_PTY_NO_MODEL');
      expect(results.replacement.output).toContain('AETHER_E2E_CODEX_FIXTURE_REAL_PTY_NO_MODEL');
      expect(results.replacement.pid).not.toBe(results.first.pid);
    } finally {
      await app.close();
    }
  });
  test('the dashboard metrics row renders real-usage data', async () => {
    const { app, window } = await launchApp();
    try {
      await window.locator('[data-testid="sidebar-nav"]').getByRole('button', { name: 'Dashboard', exact: true }).click();
      await expect(window.getByText('Tokens used')).toBeVisible({ timeout: 15000 });
    } finally {
      await app.close();
    }
  });
});
