// electron/asarUnpackClosure.test.ts
//
// Guards a packaging invariant that no other test in this repo can see.
//
// Both Codex entry points are spawned as SEPARATE child processes
// (spawn(process.execPath, [script]) -- see electron/crossEngine/acpProcess.ts).
// A child started from an unpacked script resolves its imports relative to that
// physical path, so the script's ENTIRE transitive runtime closure has to be
// unpacked alongside it. If any package in that closure is left inside
// app.asar, the child dies with module-not-found before doing any work.
//
// Nothing else catches this. `npm test` and `npm run electron:dev` both resolve
// out of a normal node_modules tree, where the bug cannot exist; it appears only
// in a packaged build. PR #75 shipped exactly this defect once already -- the
// entry scripts were unpacked, their five runtime dependencies were not.
//
// Deliberately dependency-free. Using minimatch/js-yaml here would mean relying
// on an UNDECLARED transitive dependency, reintroducing the same class of silent
// rot this test exists to prevent, so the glob matcher and the YAML list reader
// below are both small and local.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** The two scripts acpProcess.ts hands to a child process, plus node-pty, whose
 *  native DLLs Windows cannot map out of an archive. */
const MUST_BE_UNPACKED_ROOTS = [
  '@agentclientprotocol/codex-acp', // resolveAdapterExecutable()
  '@openai/codex', //                  resolveCodexCliEntry()
  'node-pty',
];

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** Minimal glob -> RegExp: `**` spans separators, `*` does not. Enough for the
 *  handful of patterns asarUnpack accepts, and no dependency. */
function globToRegExp(glob: string): RegExp {
  let body = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      // `**/` must be able to match ZERO leading segments, so that
      // `**/node_modules/**` covers a bare `node_modules/zod` and not just a
      // nested one. Compiling it to `.*/` instead silently matches nothing at
      // the top level, which makes the coverage assertion look like a config
      // failure when the matcher is what is broken.
      body += '(?:.*/)?';
      i += 3;
    } else if (glob.startsWith('**', i)) {
      body += '.*';
      i += 2;
    } else if (glob[i] === '*') {
      body += '[^/]*';
      i += 1;
    } else {
      body += escapeRe(glob[i]);
      i += 1;
    }
  }
  return new RegExp(`^${body}$`);
}

/** Reads the asarUnpack list out of electron-builder.yml without a YAML parser.
 *  The block is a flat list of single-quoted scalars; anything else should fail
 *  loudly rather than silently yield an empty list that passes every assertion. */
function readAsarUnpackPatterns(): string[] {
  const yml = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8');
  const lines = yml.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trimEnd() === 'asarUnpack:');
  expect(start, 'electron-builder.yml has no asarUnpack: block').toBeGreaterThanOrEqual(0);

  const patterns: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s+-\s+'(.+)'\s*$/.exec(line);
    if (m) {
      patterns.push(m[1]);
      continue;
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    break; // dedented to the next top-level key
  }
  expect(patterns.length, 'asarUnpack parsed as empty -- reader is out of step with the file').toBeGreaterThan(0);
  return patterns;
}

/** Walks package.json `dependencies` transitively, as Node would at runtime.
 *  devDependencies are excluded: they are not present in a packaged build. */
function runtimeClosure(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const visit = (pkg: string) => {
    if (seen.has(pkg)) return;
    seen.add(pkg);
    const manifest = join(process.cwd(), 'node_modules', ...pkg.split('/'), 'package.json');
    if (!existsSync(manifest)) return;
    const deps = JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {};
    for (const dep of Object.keys(deps)) visit(dep);
  };
  roots.forEach(visit);
  return seen;
}

describe('asarUnpack covers the spawned entry points and their runtime closure', () => {
  it('unpacks every package the child processes resolve at runtime', () => {
    const matchers = readAsarUnpackPatterns().map(globToRegExp);
    const closure = [...runtimeClosure(MUST_BE_UNPACKED_ROOTS)].sort();

    // A closure this small means the walk failed to find manifests rather than
    // that the tree is genuinely tiny -- assert it did real work.
    expect(closure.length, 'runtime closure looks empty; is node_modules installed?').toBeGreaterThan(3);

    // Match a representative FILE inside each package, not the bare directory.
    // A legitimate per-package pattern ends in `/**`, which covers the package's
    // contents but not its own directory path -- testing the bare path would
    // report such a package as uncovered when it is in fact fully unpacked.
    const unmatched = closure.filter(
      (pkg) => !matchers.some((re) => re.test(`node_modules/${pkg}/package.json`)),
    );
    expect(
      unmatched,
      `these packages are resolved by a spawned child but left inside app.asar:\n  ${unmatched.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the matcher itself distinguishes covered from uncovered paths', () => {
    // Without this, a matcher bug that matched everything would make the
    // assertion above vacuously true.
    const broad = globToRegExp('**/node_modules/**');
    expect(broad.test('node_modules/zod')).toBe(true);
    expect(broad.test('resources/app.asar.unpacked/node_modules/zod')).toBe(true);
    expect(broad.test('out/main/index.js')).toBe(false);

    const narrow = globToRegExp('**/node_modules/@agentclientprotocol/codex-acp/**');
    expect(narrow.test('node_modules/@agentclientprotocol/codex-acp/dist/index.js')).toBe(true);
    expect(narrow.test('node_modules/@agentclientprotocol/sdk')).toBe(false);
    expect(narrow.test('node_modules/zod')).toBe(false);
  });
});
