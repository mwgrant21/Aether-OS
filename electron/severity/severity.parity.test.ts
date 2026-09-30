import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { CORE_FILES, renderCollectorCopy, importSpecifiers } from '../../scripts/sync-severity-core.mjs';

// The collector is a standalone zero-dependency process, so it carries a
// GENERATED copy of the severity core. If the copies drift, this fails. Fix it
// by running `node scripts/sync-severity-core.mjs`, never by editing
// collector/src/severity/ by hand.
const repoRoot = join(__dirname, '..', '..');
const lf = (s: string) => s.replace(/\r\n/g, '\n');

describe('severity core: generated collector copy', () => {
  it.each([...CORE_FILES])('collector/src/severity/%s is exactly the generated form of the electron source', (f) => {
    const electron = readFileSync(join(repoRoot, 'electron', 'severity', f), 'utf8');
    const collector = readFileSync(join(repoRoot, 'collector', 'src', 'severity', f), 'utf8');
    expect(lf(collector)).toBe(lf(renderCollectorCopy(electron, f)));
  });

  it('collector/src/severity holds only generated core files', () => {
    const present = readdirSync(join(repoRoot, 'collector', 'src', 'severity')).sort();
    expect(present).toEqual([...CORE_FILES].sort());
  });

  it('core sources import only ./ siblings or node: builtins', () => {
    for (const f of CORE_FILES) {
      const src = readFileSync(join(repoRoot, 'electron', 'severity', f), 'utf8');
      for (const spec of importSpecifiers(src)) {
        expect(spec.startsWith('./') || spec.startsWith('node:')).toBe(true);
      }
    }
  });

  it('rewrites relative imports to .js for the NodeNext collector', () => {
    const out = renderCollectorCopy("import type { X } from './parseDispatchOutcome';\nexport const a = 1;\n", 'x.ts');
    expect(out).toContain("from './parseDispatchOutcome.js'");
    expect(out.startsWith('// GENERATED from electron/severity/x.ts')).toBe(true);
  });

  it('importSpecifiers sees from, side-effect and dynamic imports, but not comments or strings', () => {
    const src = [
      "import type { A } from './a';",
      "import {",
      "  B,",
      "} from 'pkg';",
      "import './side';",
      "export * from './re';",
      "const d = await import('./dyn');",
      "// import('./in-comment');",
      "const s = \"import('./in-string')\";",
      "// import './commented-side';",
    ].join('\n');
    expect(importSpecifiers(src)).toEqual(['./a', 'pkg', './side', './re', './dyn']);
  });

  it('rewrites side-effect, re-export and dynamic imports, leaving comments and strings alone', () => {
    const src = [
      "import './side';",
      "export { x } from './re';",
      "const d = await import('./dyn');",
      "// import('./in-comment');",
      "const s = \"import('./in-string')\";",
      "import p from 'node:path';",
      "",
    ].join('\n');
    const out = renderCollectorCopy(src, 'x.ts');
    expect(out).toContain("import './side.js';");
    expect(out).toContain("from './re.js'");
    expect(out).toContain("await import('./dyn.js')");
    expect(out).toContain("// import('./in-comment');");
    expect(out).toContain("\"import('./in-string')\"");
    expect(out).toContain("from 'node:path'");
  });
});
