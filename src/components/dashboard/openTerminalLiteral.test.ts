// @vitest-environment node
//
// Spec 2026-09-29-readiness-pass item 5: every OPEN TERMINAL renders through
// OpenTerminalButton, so the desktop-app check (aria-disabled + reason) is
// shared. This scans the TypeScript AST of every non-test source file under
// src/ for a string literal or JSX text whose trimmed value IS the label.
// Comments are never visited. A sentence that names the control (READINESS's
// "Use OPEN TERMINAL below.") is not a rendering of it, hence exact match.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const LABEL = 'OPEN TERMINAL';
const OWNER = path.join('src', 'components', 'dashboard', 'OpenTerminalButton.tsx');

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
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) && node.text.trim() === LABEL) hits++;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

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
