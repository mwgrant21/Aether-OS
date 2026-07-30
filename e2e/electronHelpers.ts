import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
}

export async function launchApp(): Promise<LaunchedApp> {
  // GPU-accelerated Electron launch can crash immediately in constrained/CI
  // containers with no working GPU/display. Only relax sandboxing there --
  // never unconditionally, since that would weaken sandboxing on a normal
  // developer machine with a working GPU.
  const extraArgs = process.env.CI || process.env.E2E_DISABLE_GPU ? ['--disable-gpu', '--no-sandbox'] : [];
  const app = await electron.launch({ args: ['.', ...extraArgs] });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}
