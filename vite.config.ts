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
        // A git worktree carries a full second copy of this suite, so a root
        // run collects every test twice and reports failures from whatever
        // stale branch the worktree is parked on -- tests that are correct for
        // that branch and meaningless here.
        //
        // Matched at ANY depth, under both directory names in use. CLAUDE.md's
        // convention is `.worktrees/<branch>/`, but Claude Code creates its own
        // at `.claude/worktrees/<branch>/`, which a root-anchored
        // `.worktrees/**` never matched -- the stale
        // `.claude/worktrees/aether-packages-core-task4` on this machine was
        // contributing 121 test files and 3 phantom failures to every local
        // run. Nothing tracked in this repo lives under a directory named
        // `.worktrees`, so that glob cannot swallow real source -- but
        // `worktrees` (no leading dot) is a plain word an ordinary source
        // directory could legitimately use (e.g. `src/worktrees/foo.test.ts`),
        // so that exclusion is scoped to Claude Code's specific nesting under
        // `.claude/` rather than matching the bare word at any depth.
        '**/.worktrees/**',
        '**/.claude/worktrees/**',
      ],
    },
  };
});
