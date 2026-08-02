// src/shared/modelPolicyEnforcement.test.ts
//
// This is the allowlist test the handoff (STAGE_11.5_HANDOFF.md §3, requirement
// 3) calls for: it scans the actual source tree rather than trusting that
// modelPolicy.ts stayed the only place model IDs live. Same shape as
// persistence.test.ts's coverage test -- encode *why* a miss matters, not just
// *what* the current state is, so a future feature adding a third model call
// site fails loudly instead of silently replaying the Stage 11.5 defect.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ALLOWED_MODELS } from './modelPolicy';

const ROOTS = ['src', 'electron', 'vite-plugins'];
const OWNING_FILES = new Set([
  path.normalize('src/shared/modelPolicy.ts'),
  path.normalize('src/shared/chatCore.ts'),
]);
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

describe('model policy enforcement', () => {
  it('no model-ID literal appears outside the owning files', () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      const rel = path.normalize(path.relative('.', file));
      if (OWNING_FILES.has(rel)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const model of ALLOWED_MODELS) {
        if (text.includes(model)) offenders.push(`${rel} references "${model}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no messages.create call appears outside chatCore.ts', () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      const rel = path.normalize(path.relative('.', file));
      if (rel === path.normalize('src/shared/chatCore.ts')) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (/messages\.create\s*\(/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  // The two checks above only catch the two models modelPolicy.ts already
  // knows about -- they cannot catch an entirely NEW, unapproved model ID
  // introduced somewhere else (e.g. a new file hardcoding a model string and
  // passing it as an argument, never as a literal named in ALLOWED_MODELS).
  // This scans for the shape of a Claude model ID generically, so the build
  // fails the moment ANY such literal becomes reachable outside the owning
  // files -- not just the two currently-approved ones.
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

  it('no new/unapproved Claude model-ID-shaped literal appears outside the owning files', () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      const rel = path.normalize(path.relative('.', file));
      if (OWNING_FILES.has(rel)) continue;
      if (LITERAL_EXCEPTIONS.has(rel)) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (MODEL_ID_SHAPE.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
