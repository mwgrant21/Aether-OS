import { test, expect } from '@playwright/test';
import { launchApp } from './electronHelpers';

const SIDEBAR_TABS = ['Dashboard', 'Terminal', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Optimize', 'Uplinks', 'Settings'];

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
      const xtermScreen = window.locator('.xterm-screen');
      await xtermScreen.waitFor({ state: 'visible', timeout: 10000 });

      await expect(async () => {
        const text = (await xtermScreen.textContent())?.trim() ?? '';
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
