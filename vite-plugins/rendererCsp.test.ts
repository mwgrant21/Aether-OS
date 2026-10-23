// vite-plugins/rendererCsp.test.ts
//
// Pins the renderer CSP: the exact prod string, the dangerous-token bans, the
// plugin's dev/prod switch, and source scans that tie `connect-src 'none'` to
// the code (a feature needing the network must change the policy on purpose).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RENDERER_CSP_PROD, RENDERER_CSP_DEV, rendererCspPlugin } from './rendererCsp';

const ROOT = resolve(__dirname, '..');

function parse(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...tokens] = part.trim().split(/\s+/);
    if (name) out.set(name, tokens);
  }
  return out;
}

const NONE = ["'none'"];

describe('renderer CSP policy', () => {
  it('PROD policy equals the exact expected string', () => {
    expect(RENDERER_CSP_PROD).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
  });

  it('neither policy allows eval or wasm eval', () => {
    for (const p of [RENDERER_CSP_PROD, RENDERER_CSP_DEV]) {
      expect(p).not.toContain('unsafe-eval');
      expect(p).not.toContain('wasm-unsafe-eval');
    }
  });

  it("default-src is exactly 'none' in both", () => {
    expect(parse(RENDERER_CSP_PROD).get('default-src')).toEqual(NONE);
    expect(parse(RENDERER_CSP_DEV).get('default-src')).toEqual(NONE);
  });

  it("PROD forbids inline script and all connections; object-src/base-uri are 'none' in both", () => {
    const prod = parse(RENDERER_CSP_PROD);
    expect(prod.get('script-src')).not.toContain("'unsafe-inline'");
    expect(prod.get('connect-src')).toEqual(NONE);
    for (const p of [prod, parse(RENDERER_CSP_DEV)]) {
      expect(p.get('object-src')).toEqual(NONE);
      expect(p.get('base-uri')).toEqual(NONE);
    }
  });

  it('no wildcard host or network scheme sources; DEV connect-src is loopback only', () => {
    const banned = new Set(['*', 'http:', 'https:', 'ws:', 'wss:', 'blob:', 'filesystem:']);
    for (const p of [RENDERER_CSP_PROD, RENDERER_CSP_DEV]) {
      for (const tokens of parse(p).values()) {
        for (const t of tokens) expect(banned.has(t)).toBe(false);
      }
    }
    expect(parse(RENDERER_CSP_DEV).get('connect-src')).toEqual([
      "'self'",
      'ws://localhost:*',
      'ws://127.0.0.1:*',
    ]);
  });

  it('neither policy uses directives that a meta tag ignores', () => {
    for (const p of [RENDERER_CSP_PROD, RENDERER_CSP_DEV]) {
      const d = parse(p);
      for (const name of ['frame-ancestors', 'report-uri', 'sandbox']) expect(d.has(name)).toBe(false);
    }
  });
});

describe('rendererCspPlugin', () => {
  function run(command: 'build' | 'serve') {
    const plugin = rendererCspPlugin() as any;
    plugin.configResolved({ command });
    const hook = plugin.transformIndexHtml;
    const fn = typeof hook === 'function' ? hook : hook.handler;
    return fn('<html></html>', {} as any);
  }

  it('injects the PROD meta at head-prepend on build and DEV on serve', () => {
    const build = run('build');
    expect(build).toHaveLength(1);
    expect(build[0]).toEqual({
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: RENDERER_CSP_PROD },
      injectTo: 'head-prepend',
    });
    expect(run('serve')[0].attrs.content).toBe(RENDERER_CSP_DEV);
  });
});

describe('source scans', () => {
  it('electron.vite.config.ts wires the plugin and index.html stays policy-free', () => {
    expect(readFileSync(join(ROOT, 'electron.vite.config.ts'), 'utf8')).toContain('rendererCspPlugin(');
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\bon\w+\s*=/i);
    expect(html).not.toMatch(/http-equiv/i);
  });

  it('renderer source has no eval, workers, network or embedding primitives', () => {
    const forbidden = [
      /\beval\(/, /new Function\(/, /new Worker\(/, /new SharedWorker\(/, /new WebSocket\(/,
      /\bfetch\(/, /XMLHttpRequest/, /new EventSource\(/, /createObjectURL/, /<iframe/, /<webview/,
    ];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue; }
        if (!/\.tsx?$/.test(e.name) || /\.test\.|\.d\.ts$/.test(e.name)) continue;
        const lines = readFileSync(full, 'utf8').split('\n');
        lines.forEach((line, i) => {
          for (const re of forbidden) if (re.test(line)) hits.push(`${full}:${i + 1} ${re}`);
        });
      }
    };
    walk(join(ROOT, 'src'));
    expect(hits).toEqual([]);
  });
});
