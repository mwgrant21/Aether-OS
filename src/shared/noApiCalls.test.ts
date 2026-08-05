// src/shared/noApiCalls.test.ts
//
// Replaces modelPolicyEnforcement.test.ts's allowlist-shaped guard now that the
// model-policy module it protected (modelPolicy.ts) is gone. That module was the
// last remaining API call site; this file proves the app has no path back to a
// paid API call short of reinstalling a dependency and writing new code -- see
// the $10.76/day incident (2026-08-04) and docs/superpowers/plans's
// 2026-08-05-api-teardown-stage13.5.md for why this exists.
//
// Reuses the ROOTS / SKIP_DIR_NAMES / walk() / allSourceFiles() scaffolding
// verbatim from modelPolicyEnforcement.test.ts -- proven, deliberate reuse.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['src', 'electron', 'vite-plugins'];
const SKIP_DIR_NAMES = new Set(['node_modules', '.worktrees', 'dist', 'dist-electron', 'release']);

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
}

function allSourceFiles(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) walk(root, out);
  return out;
}

describe('no API calls', () => {
  it('@anthropic-ai/sdk is not a dependency or devDependency', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['@anthropic-ai/sdk']).toBeUndefined();
    expect(pkg.devDependencies?.['@anthropic-ai/sdk']).toBeUndefined();
  });

  it('no source file imports @anthropic-ai/sdk', () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      const rel = path.normalize(path.relative('.', file));
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('@anthropic-ai/sdk')) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('no source file references api.anthropic.com', () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      const rel = path.normalize(path.relative('.', file));
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('api.anthropic.com')) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('no source file contains a messages.create( call', () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      const rel = path.normalize(path.relative('.', file));
      const text = fs.readFileSync(file, 'utf8');
      if (/messages\.create\s*\(/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  // Generic model-ID shape check. With ALLOWED_MODELS gone, this is the only
  // model-ID guard left -- that is intended. Stage 15 will lean on this same
  // pattern.
  const MODEL_ID_SHAPE = /claude-[a-z]+-\d/;

  // Legitimate non-call-site literals: pricing/comparison-only model-ID
  // strings that are not actual API call model selections. Each entry names
  // the file and the reason it's excluded, so this list stays a deliberate,
  // reviewed set rather than a silent escape hatch.
  const LITERAL_EXCEPTIONS: ReadonlySet<string> = new Set([
    // costForEvent({ ...e, model: 'claude-sonnet-4-6' }) computes a
    // hypothetical "what would Sonnet have cost" comparison for the
    // opus-on-trivial-turns Optimize finding -- not a call site, no
    // messages.create involved.
    path.normalize('src/shared/optimizeRules.ts'),
  ]);

  it('no new/unapproved Claude model-ID-shaped literal appears outside LITERAL_EXCEPTIONS', () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      const rel = path.normalize(path.relative('.', file));
      if (LITERAL_EXCEPTIONS.has(rel)) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (MODEL_ID_SHAPE.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
