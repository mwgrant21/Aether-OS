import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
}

export async function launchApp(): Promise<LaunchedApp> {
  const app = await electron.launch({ args: ['.'] });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}
