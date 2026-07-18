/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
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
    },
  };
});
