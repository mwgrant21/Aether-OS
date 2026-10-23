// Content Security Policy for the main renderer window, injected into index.html
// as a <meta http-equiv> by the renderer build (electron.vite.config.ts).
//
// style-src keeps 'unsafe-inline' because xterm.js 6.0.0's DomRenderer injects a
// <style> element with no nonce support; it affects CSS only, not scripts.
// The dev policy differs from prod in exactly two places: script-src gains
// 'unsafe-inline' (React Fast Refresh preamble) and connect-src allows the
// loopback Vite HMR socket. Neither reaches the packaged build.
import type { Plugin } from 'vite';

const COMMON = [
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
];
const TAIL = ["object-src 'none'", "base-uri 'none'", "form-action 'none'"];

export const RENDERER_CSP_PROD: string = [
  "default-src 'none'",
  "script-src 'self'",
  ...COMMON,
  "connect-src 'none'",
  ...TAIL,
].join('; ');

export const RENDERER_CSP_DEV: string = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  ...COMMON,
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
  ...TAIL,
].join('; ');

export function rendererCspPlugin(): Plugin {
  let command: 'build' | 'serve' = 'build';
  return {
    name: 'aether-renderer-csp',
    configResolved(config) {
      command = config.command;
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: command === 'serve' ? RENDERER_CSP_DEV : RENDERER_CSP_PROD,
          },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}
