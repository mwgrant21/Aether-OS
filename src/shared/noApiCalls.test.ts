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
import fs, { readFileSync } from 'node:fs';
import path, { resolve } from 'node:path';

// collector-go/ is a pure Go module (cmd/, internal/, go.mod) with no JS/TS
// anywhere in it -- out of scope for this JS/TS-source guard by construction,
// not by an oversight. If it ever grows a JS/TS component, add it here.
const ROOTS = ['src', 'electron', 'vite-plugins', 'scripts', 'collector'];
const SKIP_DIR_NAMES = new Set(['node_modules', '.worktrees', 'dist', 'dist-electron', 'release']);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];

function isTestOrDecl(name: string): boolean {
  return (
    name.endsWith('.test.ts') ||
    name.endsWith('.test.tsx') ||
    name.endsWith('.test.js') ||
    name.endsWith('.d.ts')
  );
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) &&
      !isTestOrDecl(entry.name)
    ) {
      out.push(full);
    }
  }
}

function allSourceFiles(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    if (fs.existsSync(root)) walk(root, out);
  }
  return out;
}

// Minimal regex-over-source-tree helper for the cross-engine boundary tests
// below. Reuses allSourceFiles() rather than re-walking the tree.
function grepSourceFor(pattern: RegExp): string[] {
  const offenders: string[] = [];
  for (const file of allSourceFiles()) {
    const rel = path.normalize(path.relative('.', file));
    const text = fs.readFileSync(file, 'utf8');
    if (pattern.test(text)) offenders.push(rel);
  }
  return offenders;
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

  it('collector/package.json (separate npm package) does not depend on @anthropic-ai/sdk either', () => {
    const collectorPkgPath = path.join('collector', 'package.json');
    if (!fs.existsSync(collectorPkgPath)) return;
    const pkg = JSON.parse(fs.readFileSync(collectorPkgPath, 'utf8')) as {
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

describe('cross-engine Codex boundary', () => {
  it('the general OpenAI API SDK is not a dependency', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
    expect(pkg.dependencies?.openai).toBeUndefined();
    expect(pkg.devDependencies?.openai).toBeUndefined();
  });

  it('no source file calls the OpenAI or Anthropic HTTP APIs directly', () => {
    const hits = grepSourceFor(/api\.openai\.com|api\.anthropic\.com/);
    expect(hits).toEqual([]);
  });

  it('only the reviewed ACP process module references the Codex adapter executable', () => {
    const hits = grepSourceFor(/codex-acp/).filter((f) => {
      const posix = f.replace(/\\/g, '/'); // path.normalize() yields backslashes on Windows
      return !posix.includes('electron/crossEngine/acpProcess.ts') && !posix.includes('.test.ts') && !posix.includes('docs/');
    });
    expect(hits).toEqual([]);
  });

  // Blocked-billing-variable removal (acpProcess.ts's child-environment builder)
  // and the chat-gpt-only authentication gate (codexVerifier.ts, checked immediately
  // before every verification turn, not only at connect time) are already covered by
  // acpProcess.test.ts and codexVerifier.test.ts respectively -- not duplicated here.
  //
  // What is NOT covered elsewhere: that persistence.ts's persisted-fields whitelist
  // exposes only the opt-in config, never a raw verification payload
  // (VerificationResultV1's findings/summary/etc content). That's a source-tree
  // boundary check, which is this file's job.
  it('persistence.ts persists only crossEngineCfg (the opt-in flag), never a raw verification result', () => {
    const persistenceSrc = readFileSync(resolve(__dirname, '../state/persistence.ts'), 'utf8');
    const sliceMatch = persistenceSrc.match(/const slice: Partial<AetherState> = \{([\s\S]*?)\};/);
    expect(sliceMatch).not.toBeNull();
    const sliceBody = sliceMatch![1];
    const crossEngineKeys = [...sliceBody.matchAll(/^\s*(\w*[Cc]rossEngine\w*)\s*:/gm)].map((m) => m[1]);
    expect(crossEngineKeys).toEqual(['crossEngineCfg']);
    // Belt-and-suspenders: the persisted slice must never reference the result type
    // or its fields (verdict/findings/summary/tests) by name.
    expect(sliceBody).not.toMatch(/VerificationResultV1|verificationResult|lastVerification/);
  });
});
