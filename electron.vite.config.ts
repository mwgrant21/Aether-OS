import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  main: {
    build: {
      lib: { entry: resolve(__dirname, 'electron/main.ts') },
    },
  },
  preload: {
    build: {
      lib: { entry: resolve(__dirname, 'electron/preload.ts') },
      rollupOptions: {
        // Force CJS output even though package.json has "type": "module".
        // Electron's sandboxed preload context (sandbox: true, the default)
        // cannot execute ESM `import` statements, so the preload bundle must
        // stay CommonJS regardless of the rest of the project being ESM.
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    root: '.',
    server: {
      watch: {
        // `dist/` and `out/` are build output and are gitignored, but the dev
        // server watches them anyway by default -- so running a build while a
        // dev window is open triggers a full page reload of the running app,
        // for a file nobody edited. Issue #22 recorded a reload at 10:38:32
        // with no project file changed in that window; this is the mechanism
        // that makes such a reload possible. Not proven to be that incident's
        // trigger -- the decisive renderer state was lost -- but it is a real
        // latent trigger regardless, and cheap to remove.
        ignored: ['**/dist/**', '**/out/**'],
      },
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
      },
    },
    plugins: [react()],
  },
});
