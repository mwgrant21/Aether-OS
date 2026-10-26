// @vitest-environment node
// electron/thread/threadBoundary.test.ts
//
// AST guard for the control-scoped session thread feed (docs/privacy-and-data.md section 17, spec D-I2/D-I3).
// electron/thread/ reads one transcript, read-only, and hands redacted entries to electron/control through
// ThreadReadPort. This fails if the directory gains: a pty/ws/http/net/child_process/electron value import or an import of
// electron/remote or electron/control; any fs use outside threadFeed.ts; any fs name beyond promises.open(file, 'r') /
// promises.stat / handle.read / handle.close; a write-capable fs name anywhere; a ThreadEntry literal built outside
// threadParser.ts (the only place that redacts before constructing); a redaction bypass parameter; a log call that is not
// the one fixed metadata line; or dynamic code / environment / network globals.
//
// Parsed with the TypeScript compiler API (syntax only), like electron/control/controlBoundary.test.ts, so comments and
// string contents are never read as code. Name-based and scope-insensitive: a guard against drift, not a sandbox.
// Out of reach: transitive imports (an allowed module doing something unsafe) and test files, which are not analysed.
// The ENGINE tests run the same analyzer over planted fixtures so every rule is proven live and an empty or
// unreadable tree cannot make the real-tree test pass vacuously.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const DIR = __dirname;
const OWN_FILES = ['threadFeed', 'threadPort', 'threadParser', 'threadRedact'] as const;
const ALLOWED_NAMES: ReadonlySet<string> = new Set([
  ...OWN_FILES.flatMap((f) => [`${f}.ts`, `${f}.test.ts`]),
  'threadBoundary.test.ts',
]);

type Rule = 'syntax' | 'module' | 'fs' | 'write' | 'entry' | 'bypass' | 'log' | 'global';
const ALL_RULES: readonly Rule[] = ['syntax', 'module', 'fs', 'write', 'entry', 'bypass', 'log', 'global'];
interface Violation { rule: Rule; msg: string }

const COMMON_IMPORTS: ReadonlySet<string> = new Set([
  './threadFeed', './threadPort', './threadParser', './threadRedact',
  '../../src/shared/remote/threadTypes', '../../src/shared/board/text', '../board/boardFeed', '../transcriptParser',
]);
const FORBIDDEN_MODULE = /^(?:node:)?(?:child_process|http|https|net|ws|fs\/promises|worker_threads|vm|dgram|tls|http2|cluster)$|node-pty|ptyManager|codexPtyManager|ptyLifecycle|permissionServer|communicationBridge|electron\/(?:remote|control)|\.\.\/(?:remote|control)\//;
const WRITE_NAMES: ReadonlySet<string> = new Set([
  'write', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'rename', 'renameSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'truncate', 'truncateSync',
  'ftruncate', 'symlink', 'symlinkSync', 'link', 'chmod', 'chown', 'utimes', 'futimes', 'writeSync', 'writev', 'writevSync', 'createWriteStream',
]);
const FS_PROMISES_ALLOWED: ReadonlySet<string> = new Set(['open', 'stat']);
const FS_HANDLE_ALLOWED: ReadonlySet<string> = new Set(['read', 'close']);
const DENY_IDENT: ReadonlySet<string> = new Set([
  'eval', 'Function', 'require', 'createRequire', 'process', 'globalThis', 'global', 'Reflect', 'console',
  'fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'Worker', 'window', 'self',
]);
// The only call to `log` anywhere in the directory (spec 4.7); no text, ids, paths or bodies can reach it.
const ALLOWED_LOG_ARGS: ReadonlySet<string> = new Set(['`thread: transcript unreadable slot=${slot}`']);
const BYPASS_NAME = /bypass|skip.*redact|no.*redact|unredact|redact.*(?:off|disable)|disable.*redact|^raw(?:text)?$|^unsafe/i;
const ENTRY_KINDS: ReadonlySet<string> = new Set(['u', 'a', 't', 'th']);

type StrLit = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;
const isStrLit = (n: ts.Node | undefined): n is StrLit =>
  !!n && (n.kind === ts.SyntaxKind.StringLiteral || n.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral);
const keyText = (n: ts.Node | undefined): string | null => (n && (ts.isIdentifier(n) || isStrLit(n)) ? n.text : null);
function visit(node: ts.Node, fn: (n: ts.Node) => void): void { fn(node); ts.forEachChild(node, (c) => visit(c, fn)); }
function memberName(n: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n) && isStrLit(n.argumentExpression)) return n.argumentExpression.text;
  return null;
}

function analyze(name: string, text: string): Violation[] {
  const found = new Map<string, Violation>();
  const v = (rule: Rule, msg: string): void => { found.set(`${rule}:${msg}`, { rule, msg }); };
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diags = ts.transpileModule(text, { fileName: name, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, isolatedModules: true } }).diagnostics ?? [];
  for (const d of diags) if (d.category === ts.DiagnosticCategory.Error) v('syntax', 'syntax error (cannot prove the file safe)');

  const mayUseFs = name === 'threadFeed.ts';
  const fsAliases = new Set<string>(); // local names bound to fs.promises
  const handleNames = new Set<string>(); // local names bound to an opened handle

  visit(sf, (n) => {
    // ---- imports and re-exports ----
    let spec: string | null | undefined;
    let typeOnly = false;
    let named: ts.NamedImports | null = null;
    if (ts.isImportDeclaration(n)) {
      spec = isStrLit(n.moduleSpecifier) ? n.moduleSpecifier.text : null;
      const c = n.importClause;
      typeOnly = !!c && c.isTypeOnly;
      named = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings : null;
      if (c && !typeOnly && !c.name && named && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly)) typeOnly = true;
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      spec = isStrLit(n.moduleSpecifier) ? n.moduleSpecifier.text : null;
      typeOnly = n.isTypeOnly;
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      spec = isStrLit(n.moduleReference.expression) ? n.moduleReference.expression.text : null;
    } else if (ts.isCallExpression(n) && ((ts.isIdentifier(n.expression) && n.expression.text === 'require') || n.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      spec = n.arguments.length === 1 && isStrLit(n.arguments[0]) ? n.arguments[0].text : null;
    } else if (ts.isImportTypeNode(n)) {
      spec = ts.isLiteralTypeNode(n.argument) && isStrLit(n.argument.literal) ? n.argument.literal.text : null;
      typeOnly = true;
    }
    if (spec !== undefined) {
      if (spec === null) v('module', 'dynamic module specifier');
      else {
        const bare = spec.replace(/^node:/, '');
        if (FORBIDDEN_MODULE.test(spec) || FORBIDDEN_MODULE.test(bare)) v('module', `forbidden module: ${spec}`);
        else if (bare === 'electron' && !typeOnly) v('module', 'electron value import');
        else if (bare === 'fs') {
          if (!mayUseFs) v('fs', 'fs imported outside threadFeed.ts');
          else if (!(ts.isImportDeclaration(n) && !typeOnly && named && named.elements.length === 1 && named.elements[0]!.name.text !== '' && (named.elements[0]!.propertyName?.text ?? named.elements[0]!.name.text) === 'promises')) {
            v('fs', "fs may be imported only as `import { promises as <alias> } from 'node:fs'`");
          } else fsAliases.add(named.elements[0]!.name.text);
        } else if (!COMMON_IMPORTS.has(spec) && !(typeOnly && bare === 'electron')) v('module', `import not on the electron/thread allow-list: ${spec}`);
      }
    }

    // ---- fs surface (threadFeed.ts only) ----
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const mem = memberName(n);
      if (ts.isElementAccessExpression(n) && mem === null && ts.isIdentifier(n.expression) && (fsAliases.has(n.expression.text) || handleNames.has(n.expression.text))) v('fs', 'computed member access on an fs object');
      if (mem !== null && WRITE_NAMES.has(mem)) v('write', `write-capable name: ${mem}`);
      const recv = n.expression;
      if (mem !== null && ts.isIdentifier(recv)) {
        if (fsAliases.has(recv.text) && !FS_PROMISES_ALLOWED.has(mem)) v('fs', `fs.promises.${mem} is not on the read-only list (open, stat)`);
        if (handleNames.has(recv.text) && !FS_HANDLE_ALLOWED.has(mem)) v('fs', `handle.${mem} is not on the read-only list (read, close)`);
      }
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      let init: ts.Expression = n.initializer;
      if (ts.isAwaitExpression(init)) init = init.expression;
      if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && ts.isIdentifier(init.expression.expression) && fsAliases.has(init.expression.expression.text) && init.expression.name.text === 'open') {
        handleNames.add(n.name.text);
      }
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && fsAliases.has(n.expression.expression.text) && n.expression.name.text === 'open') {
      const flag = n.arguments[1];
      if (!flag || !isStrLit(flag) || flag.text !== 'r') v('fs', "fs.promises.open must pass the literal flag 'r'");
    }
    if (ts.isShorthandPropertyAssignment(n) && WRITE_NAMES.has(n.name.text)) v('write', `write-capable name: ${n.name.text}`);
    if (ts.isBindingElement(n) && ts.isIdentifier(n.name) && WRITE_NAMES.has((n.propertyName && keyText(n.propertyName)) || n.name.text)) v('write', 'write-capable name in a destructuring');
    if (ts.isImportSpecifier(n) && WRITE_NAMES.has((n.propertyName ?? n.name).text)) v('write', `write-capable import: ${(n.propertyName ?? n.name).text}`);

    // ---- ThreadEntry literals only in the parser ----
    if (ts.isObjectLiteralExpression(n) && name !== 'threadParser.ts') {
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p) && keyText(p.name) === 'k' && isStrLit(p.initializer) && ENTRY_KINDS.has(p.initializer.text)) {
          v('entry', `ThreadEntry literal (k: '${p.initializer.text}') built outside threadParser.ts`);
        }
      }
    }

    // ---- no redaction bypass ----
    if ((ts.isParameter(n) || ts.isPropertySignature(n) || ts.isBindingElement(n)) && n.name && ts.isIdentifier(n.name) && BYPASS_NAME.test(n.name.text)) {
      v('bypass', `bypass-shaped parameter or option: ${n.name.text}`);
    }

    // ---- logging: only the fixed metadata line ----
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const calleeName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (calleeName !== null && /^(log|diag|logDiag|warn|error|info|debug)$/.test(calleeName)) {
        if (n.arguments.length !== 1 || !ALLOWED_LOG_ARGS.has(n.arguments[0]!.getText(sf))) v('log', `log call that is not the fixed metadata line: ${n.getText(sf).slice(0, 60)}`);
      }
    }

    // ---- dynamic code / env / network globals ----
    if (ts.isIdentifier(n) && DENY_IDENT.has(n.text)) {
      const p = n.parent;
      const isMemberName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isPropertySignature(p) && p.name === n) || (ts.isMethodDeclaration(p) && p.name === n);
      if (!isMemberName) v('global', `denied identifier: ${n.text}`);
    }
    if (ts.isPropertyAccessExpression(n) && /^(constructor|prototype|__proto__)$/.test(n.name.text)) v('global', `denied member: ${n.name.text}`);
  });
  return [...found.values()];
}

describe('electron/thread boundary (real tree)', () => {
  const entries = fs.readdirSync(DIR, { withFileTypes: true });
  const prod = entries.filter((e) => e.isFile() && e.name.endsWith('.ts') && !/\.test\.ts$/.test(e.name)).map((e) => e.name);

  it('is not vacuous: the four production modules are present and nothing unreviewed sits beside them', () => {
    expect([...prod].sort()).toEqual(OWN_FILES.map((f) => `${f}.ts`).sort());
    for (const e of entries) {
      expect(e.isSymbolicLink(), e.name).toBe(false);
      if (e.isFile()) expect(ALLOWED_NAMES.has(e.name), `unreviewed file ${e.name}`).toBe(true);
    }
  });

  for (const f of OWN_FILES) {
    it(`${f}.ts has no violations`, () => {
      expect(analyze(`${f}.ts`, fs.readFileSync(path.join(DIR, `${f}.ts`), 'utf8')).map((x) => x.msg)).toEqual([]);
    });
  }

  it('threadFeed.ts actually reaches the read-only fs surface the guard allows (the rule sees it)', () => {
    const text = fs.readFileSync(path.join(DIR, 'threadFeed.ts'), 'utf8');
    expect(text).toMatch(/import \{ promises as fsp \} from 'node:fs'/);
    expect(text).toMatch(/fsp\.open\(file, 'r'\)/);
  });
});

describe('electron/thread boundary (engine, planted fixtures)', () => {
  const hit = (name: string, src: string): Rule[] => [...new Set(analyze(name, src).map((x) => x.rule))];

  it('clean fixtures stay clean', () => {
    expect(analyze('threadFeed.ts', "import { promises as fsp } from 'node:fs';\nimport { createParseCtx } from './threadParser';\nconst log = (s: string) => {};\nasync function f(file: string, slot: string) { const fh = await fsp.open(file, 'r'); await fsp.stat(file); await fh.read(Buffer.alloc(1), 0, 1, 0); await fh.close(); log(`thread: transcript unreadable slot=${slot}`); }")).toEqual([]);
    expect(analyze('threadParser.ts', "const e = { id: 'x', k: 'u' as const };")).toEqual([]);
  });

  const planted: { rule: Rule; name: string; src: string }[] = [
    { rule: 'module', name: 'threadFeed.ts', src: "import pty from 'node-pty';" },
    { rule: 'module', name: 'threadFeed.ts', src: "import WebSocket from 'ws';" },
    { rule: 'module', name: 'threadFeed.ts', src: "import http from 'node:http';" },
    { rule: 'module', name: 'threadFeed.ts', src: "import { spawn } from 'node:child_process';" },
    { rule: 'module', name: 'threadFeed.ts', src: "import { app } from 'electron';" },
    { rule: 'module', name: 'threadFeed.ts', src: "import { createChatFeed } from '../remote/chatFeed';" },
    { rule: 'module', name: 'threadFeed.ts', src: "import { x } from '../control/protocol';" },
    { rule: 'module', name: 'threadFeed.ts', src: "import { x } from './somethingNew';" },
    { rule: 'module', name: 'threadFeed.ts', src: 'const m = await import(name);' },
    { rule: 'fs', name: 'threadPort.ts', src: "import { promises as fsp } from 'node:fs';" },
    { rule: 'fs', name: 'threadParser.ts', src: "import fs from 'node:fs';" },
    { rule: 'fs', name: 'threadFeed.ts', src: "import fs from 'node:fs';" },
    { rule: 'fs', name: 'threadFeed.ts', src: "import { promises as fsp } from 'node:fs';\nfsp.readFile('x');" },
    { rule: 'fs', name: 'threadFeed.ts', src: "import { promises as fsp } from 'node:fs';\nfsp.open('x', 'a');" },
    { rule: 'fs', name: 'threadFeed.ts', src: "import { promises as fsp } from 'node:fs';\nfsp.open('x');" },
    { rule: 'fs', name: 'threadFeed.ts', src: "import { promises as fsp } from 'node:fs';\nasync function f() { const fh = await fsp.open('x', 'r'); await fh.sync(); }" },
    { rule: 'write', name: 'threadFeed.ts', src: "import { promises as fsp } from 'node:fs';\nfsp.writeFile('x', 'y');" },
    { rule: 'write', name: 'threadFeed.ts', src: "import { promises as fsp } from 'node:fs';\nasync function f() { const fh = await fsp.open('x', 'r'); await fh.write('y'); }" },
    { rule: 'write', name: 'threadFeed.ts', src: "const { appendFile } = deps.fs;" },
    { rule: 'write', name: 'threadFeed.ts', src: "const w = deps.fs['rename'];" },
    { rule: 'fs', name: 'threadFeed.ts', src: "import { promises as fsp } from 'node:fs'; fsp[key]('x');" },
    { rule: 'entry', name: 'threadFeed.ts', src: "const e = { id: 'x', k: 'a', x: 'y', tr: false };" },
    { rule: 'entry', name: 'threadPort.ts', src: "const e = { k: 'th', ms: null };" },
    { rule: 'bypass', name: 'threadParser.ts', src: 'export function parse(line: string, bypassRedaction: boolean) {}' },
    { rule: 'bypass', name: 'threadRedact.ts', src: 'export function redactText(s: string, o: { noRedact?: boolean }) {}' },
    { rule: 'bypass', name: 'threadParser.ts', src: 'export function parse(line: string, skipRedact = false) {}' },
    { rule: 'log', name: 'threadFeed.ts', src: 'log(entry.x);' },
    { rule: 'log', name: 'threadFeed.ts', src: 'log(`thread: transcript unreadable slot=${slot} file=${file}`);' },
    { rule: 'log', name: 'threadFeed.ts', src: "deps.log('thread: attach');" },
    { rule: 'log', name: 'threadFeed.ts', src: 'log(a, b);' },
    { rule: 'global', name: 'threadParser.ts', src: 'console.log(1);' },
    { rule: 'global', name: 'threadParser.ts', src: 'const k = process.env.NO_REDACT;' },
    { rule: 'global', name: 'threadFeed.ts', src: "fetch('http://x');" },
    { rule: 'global', name: 'threadFeed.ts', src: "eval('1');" },
    { rule: 'global', name: 'threadFeed.ts', src: 'const f = x.constructor;' },
    { rule: 'syntax', name: 'threadFeed.ts', src: 'const = ;' },
  ];
  for (const p of planted) {
    it(`flags ${p.rule}: ${p.src.replace(/\s+/g, ' ').slice(0, 70)}`, () => {
      expect(hit(p.name, p.src)).toContain(p.rule);
    });
  }

  it('every rule is tripped by at least one planted fixture', () => {
    const tripped = new Set<Rule>();
    for (const p of planted) for (const r of hit(p.name, p.src)) tripped.add(r);
    expect([...ALL_RULES].filter((r) => !tripped.has(r))).toEqual([]);
  });
});
