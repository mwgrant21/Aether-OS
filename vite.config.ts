/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
  return {
    plugins: [react()],
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
