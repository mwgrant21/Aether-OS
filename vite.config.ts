/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { chatProxyPlugin } from './vite-plugins/chatProxyPlugin';

export default defineConfig(({ mode }) => {
  // Populate process.env from .env / .env.local for the dev server's own
  // Node process (plugin code) -- Vite only does this automatically for
  // import.meta.env in client code. A real shell-exported env var always
  // wins over a .env-file value.
  const env = loadEnv(mode, process.cwd(), '');
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return {
    plugins: [react(), chatProxyPlugin()],
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test-setup.ts'],
      // collector/ is a standalone package with its own package.json, build,
      // and test command (see collector/vitest.config.ts, which explicitly
      // owns scripts/*.test.ts too). Exclude both from the root run so they
      // aren't picked up twice under the wrong (jsdom) test environment.
      exclude: [
        ...configDefaults.exclude,
        'collector/**',
        'e2e/**', // Playwright's own separate test suite, run via npm run test:e2e
        'scripts/aether-hook-emit.test.ts',
        'scripts/aether-permission-hook.test.ts',
        '.worktrees/**', // sibling git worktrees each carry their own full copy of this suite
      ],
    },
  };
});
