import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Three processes write the user's ~/.claude/settings.json: this app, the TS
// collector, and the Go collector. A difference between them is a bug by
// definition (#63), and the two TS copies exist only because collector/ is a
// separate npm package with its own build -- not because they are allowed to
// differ. The Go copy is compared against the TS one by
// collector-go/scripts/parity/run-parity.mjs; nothing compared these two until
// this test, so drift was caught by review or not at all.
const repoRoot = join(__dirname, '..');

function logicOnly(source: string): string {
  return source
    .replace(/^import[^\n]*\n/gm, '') // import style differs by design (node: prefixes)
    .replace(/\/\*\*[\s\S]*?\*\//g, '') // doc blocks
    .replace(/^\s*\/\/[^\n]*\n/gm, '') // line comments
    .replace(/\s+/g, ' ')
    .trim();
}

describe('atomicWrite parity between the Electron and collector copies', () => {
  it('is byte-identical once imports and comments are removed', () => {
    const electron = logicOnly(readFileSync(join(repoRoot, 'electron/atomicWrite.ts'), 'utf8'));
    const collector = logicOnly(readFileSync(join(repoRoot, 'collector/src/atomicWrite.ts'), 'utf8'));

    // If this fails, the two write paths have diverged. Port the change to both
    // (and to collector-go/internal/hookinstall/installer.go) rather than
    // relaxing this test -- see #63 for why they must not drift.
    expect(collector).toBe(electron);
  });

  it('exports the same surface from both copies', () => {
    const exportsOf = (p: string) =>
      [...readFileSync(join(repoRoot, p), 'utf8').matchAll(/export (?:async )?function (\w+)/g)]
        .map((m) => m[1])
        .sort();

    expect(exportsOf('collector/src/atomicWrite.ts')).toEqual(exportsOf('electron/atomicWrite.ts'));
  });

  it('keeps the Go port in step on the rules that have no test of their own', () => {
    const go = readFileSync(
      join(repoRoot, 'collector-go/internal/hookinstall/installer.go'),
      'utf8'
    );
    // Cheap structural check: the Go side must still name each rule the TS side
    // implements. It is not a proof of equivalence -- the parity harness and the
    // Go unit tests are -- but it fails loudly if a rule is deleted wholesale.
    for (const marker of ['resolveRealPath', 'hardLinked', 'linkCountOf', 'EACCES', 'createMode']) {
      expect(go).toContain(marker);
    }
  });
});
