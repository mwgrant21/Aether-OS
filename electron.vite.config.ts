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
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
      },
    },
    plugins: [react()],
  },
});
