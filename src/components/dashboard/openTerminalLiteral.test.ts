// @vitest-environment node
//
// Spec 2026-09-29-readiness-pass item 5: every OPEN TERMINAL renders through
// OpenTerminalButton, so the desktop-app check (aria-disabled + reason) is
// shared. This scans the TypeScript AST of every non-test source file under
// src/ for a string literal or JSX text whose value IS the label, allowing
// non-letter/digit trim (icons, glyphs, arrows) on either side -- so it also
// catches a copy of the owner's own rendering ('⊕ OPEN TERMINAL',
// 'OPEN TERMINAL →'). Comments are never visited. A sentence that names the
// control (READINESS's "Use OPEN TERMINAL below.") has letters on both sides
// of the match and is not a rendering of it, so it is deliberately not
// flagged. Out of scope for this literal scan: a label split across JSX
// children (`OPEN{' '}TERMINAL`), a template literal built with `${}`
// interpolation (only `NoSubstitutionTemplateLiteral` is checked), and
// string concatenation (`'OPEN ' + 'TERMINAL'`) -- none of these are a
// single AST node whose text this scanner can read.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const LABEL = 'OPEN TERMINAL';
const OWNER = path.join('src', 'components', 'dashboard', 'OpenTerminalButton.tsx');

// Matches the label with any run of non-letter/non-digit characters (icons,
// glyphs, arrows, whitespace) on either side, but not if a LETTER or DIGIT
// sits adjacent to the label on either side (so 'Use OPEN TERMINAL below.'
// does not match: 'below.' starts with a letter).
const LABEL_PATTERN = new RegExp(`^[^\\p{L}\\p{N}]*${LABEL}[^\\p{L}\\p{N}]*$`, 'u');

function isLabel(text: string): boolean {
  return LABEL_PATTERN.test(text);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function labelLiterals(file: string): number {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind);
  let hits = 0;
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) && isLabel(node.text.trim())) hits++;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe('isLabel (the literal-match predicate)', () => {
  it('matches the owner\'s own decorated renderings', () => {
    expect(isLabel('⊕ OPEN TERMINAL')).toBe(true);
    expect(isLabel('OPEN TERMINAL →')).toBe(true);
    expect(isLabel(' OPEN TERMINAL\n'.trim())).toBe(true);
  });

  it('does not match a sentence that merely names the control', () => {
    expect(isLabel('Use OPEN TERMINAL below.')).toBe(false);
  });
});

describe('OPEN TERMINAL has one renderer', () => {
  const files = sourceFiles('src');

  it('scans a real tree (never passes vacuously)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(OWNER);
  });

  it('only OpenTerminalButton.tsx carries the OPEN TERMINAL label', () => {
    expect(files.filter((f) => f !== OWNER && labelLiterals(f) > 0)).toEqual([]);
    expect(labelLiterals(OWNER)).toBe(1);
  });
});
