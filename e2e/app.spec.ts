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
    // The pty isn't a plain shell: ptyManager.js spawns powershell and immediately writes
    // `claude\r`, launching a live Claude Code CLI session. Sending arbitrary typed input into
    // that live session (e.g. `echo <marker>` expecting an echo back) is both fragile (the
    // keystrokes go into Claude's own TUI, not a shell prompt) and inappropriate for an
    // automated smoke test. Instead, verify the structural fact this test exists to prove: the
    // pty spawned and is producing real, non-trivial output (its own banner/prompt), retiring
    // the recurring manual verification.
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
        expect(text.length).toBeGreaterThan(40);
      }).toPass({ timeout: 10000 });
    } finally {
      await app.close();
    }
  });

  test('the dashboard metrics row renders real-usage data', async () => {
    const { app, window } = await launchApp();
    try {
      await expect(window.getByText('Tokens used')).toBeVisible({ timeout: 15000 });
    } finally {
      await app.close();
    }
  });
});
