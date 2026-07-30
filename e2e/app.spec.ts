import { test, expect } from '@playwright/test';
import { launchApp } from './electronHelpers';

const SIDEBAR_TABS = ['Dashboard', 'Terminal', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Optimize', 'Uplinks', 'Settings'];

test.describe('Aether OS smoke', () => {
  test('launches without crashing', async () => {
    const { app, window } = await launchApp();
    await expect(window.locator('body')).toBeVisible();
    await app.close();
  });

  test('every sidebar tab renders its view with no console errors', async () => {
    const { app, window } = await launchApp();
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
    await app.close();
  });

  test('the embedded terminal spawns a real pty and echoes a typed command', async () => {
    const { app, window } = await launchApp();
    await window.locator('[data-testid="sidebar-nav"]').getByRole('button', { name: 'Terminal', exact: true }).click();
    await window.locator('.xterm-screen').waitFor({ state: 'visible', timeout: 10000 });

    const marker = `aether-e2e-${Date.now()}`;
    await window.locator('.xterm-helper-textarea').click();
    await window.keyboard.type(`echo ${marker}`);
    await window.keyboard.press('Enter');

    await expect(window.locator('.xterm-screen')).toContainText(marker, { timeout: 10000 });
    await app.close();
  });

  test('the dashboard metrics row renders real-usage data', async () => {
    const { app, window } = await launchApp();
    await expect(window.getByText('Tokens used')).toBeVisible({ timeout: 15000 });
    await app.close();
  });
});
