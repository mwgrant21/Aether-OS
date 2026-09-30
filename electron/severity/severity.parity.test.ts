import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { CORE_FILES, renderCollectorCopy } from '../../scripts/sync-severity-core.mjs';

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
      for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        expect(m[1].startsWith('./') || m[1].startsWith('node:')).toBe(true);
      }
    }
  });

  it('rewrites relative imports to .js for the NodeNext collector', () => {
    const out = renderCollectorCopy("import type { X } from './parseDispatchOutcome';\nexport const a = 1;\n", 'x.ts');
    expect(out).toContain("from './parseDispatchOutcome.js'");
    expect(out.startsWith('// GENERATED from electron/severity/x.ts')).toBe(true);
  });
});
