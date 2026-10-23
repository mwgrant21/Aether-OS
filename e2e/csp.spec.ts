import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { launchApp } from './electronHelpers';
import { RENDERER_CSP_PROD } from '../vite-plugins/rendererCsp';

type Violation = { violatedDirective: string; blockedURI: string };
type CspWindow = { __cspViolations?: Violation[] };

// Same registry-as-text parse as app.spec.ts (importing the registry would pull in every view).
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

// Runs in every document before page scripts, so startup violations are recorded.
const RECORD_VIOLATIONS = `
window.__cspViolations = [];
document.addEventListener('securitypolicyviolation', (e) => {
  window.__cspViolations.push({ violatedDirective: e.violatedDirective, blockedURI: e.blockedURI });
});`;

const violations = (w: Page) => w.evaluate(() => (globalThis as unknown as CspWindow).__cspViolations ?? []);

test.describe('Renderer CSP (built app over file://)', () => {
  test('the production policy meta is live in the document', async () => {
    const { app, window } = await launchApp();
    try {
      const content = await window.evaluate(
        () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
      );
      expect(content).toBe(RENDERER_CSP_PROD);
      expect(window.url().startsWith('file:')).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('eval and fetch canaries are blocked, proving enforcement', async () => {
    const { app, window } = await launchApp();
    try {
      await app.context().addInitScript(RECORD_VIOLATIONS);
      await window.reload();
      await window.waitForLoadState('domcontentloaded');
      // Playwright's own evaluate() lets eval through (allowUnsafeEvalBlockedByCSP), so ask CDP
      // to enforce the page policy on the eval canary.
      const cdp = await window.context().newCDPSession(window);
      const evalResult = await cdp.send('Runtime.evaluate', {
        expression: "(() => { try { new Function('return 1')(); return 'ran'; } catch (e) { return String(e); } })()",
        allowUnsafeEvalBlockedByCSP: false,
        returnByValue: true,
      });
      expect(String(evalResult.result.value)).toMatch(/EvalError.*Content Security Policy/);
      const fetchBlocked = await window.evaluate(async () => {
        try { await fetch('https://example.invalid/'); return false; } catch { return true; }
      });
      expect(fetchBlocked).toBe(true);
      await window.waitForTimeout(200);
      const directives = (await violations(window)).map(v => v.violatedDirective);
      expect(directives.some(d => d.startsWith('script-src'))).toBe(true);
      expect(directives.some(d => d.startsWith('connect-src'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('zero violations across startup and every sidebar tab, including the terminals', async () => {
    const { app, window } = await launchApp();
    try {
      const consoleErrors: string[] = [];
      window.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      await app.context().addInitScript(RECORD_VIOLATIONS);
      await window.reload();
      await window.waitForLoadState('domcontentloaded');
      const sidebarNav = window.locator('[data-testid="sidebar-nav"]');
      for (const tab of SIDEBAR_TABS) {
        await sidebarNav.getByRole('button', { name: tab, exact: true }).click();
        await window.waitForTimeout(200);
      }
      await sidebarNav.getByRole('button', { name: 'Terminal', exact: true }).click();
      await window.locator('.xterm-screen').first().waitFor({ state: 'visible', timeout: 10000 });
      await window.waitForTimeout(500);
      expect(await violations(window)).toEqual([]);
      expect(consoleErrors.filter(t => /Content Security Policy|Refused to/.test(t))).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('the init script captures violations raised during startup', async () => {
    const { app, window } = await launchApp();
    try {
      // An image added by the init script while the document loads: img-src blocks it, and the
      // recorder (installed first) must have seen it.
      await app.context().addInitScript(`${RECORD_VIOLATIONS}
document.addEventListener('DOMContentLoaded', () => { new Image().src = 'https://example.invalid/x.png'; });`);
      await window.reload();
      await window.waitForLoadState('domcontentloaded');
      await window.waitForTimeout(300);
      const seen = await violations(window);
      expect(seen.some(v => v.violatedDirective.startsWith('img-src'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('data: images are allowed', async () => {
    const { app, window } = await launchApp();
    try {
      await app.context().addInitScript(RECORD_VIOLATIONS);
      await window.reload();
      await window.waitForLoadState('domcontentloaded');
      const loaded = await window.evaluate(() => new Promise<boolean>((resolve) => {
        const img = document.createElement('img');
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>";
      }));
      expect(loaded).toBe(true);
      expect(await violations(window)).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
