// @vitest-environment node
// electron/control/controlBoundary.test.ts
//
// AST guard for phone CONTROL (docs/privacy-and-data.md section 17), the opt-in input path that sits
// beside the read-only viewer. electron/control/ does not exist yet (slice V-1 is docs and guards), so
// this file has two halves that must both stay true:
//   1. the REAL TREE test scans electron/control/ and passes when the directory is missing or empty;
//   2. the ENGINE tests run the very same analyzer over in-memory fixtures and a scratch directory, so
//      the rules are proven live today and an empty tree cannot make them pass vacuously. Every Rule
//      must be tripped by at least one planted fixture (last test), and clean fixtures must stay clean.
//
// Parsed with the TypeScript compiler API (syntax only), like electron/remote/noWildcardListener.test.ts,
// whose engine is not exported; this file carries its own small copy and does NOT touch or relax that guard.
// Design differences from the remote engine, chosen to avoid its known gaps (PR #127): there is no text
// allow-list for dynamic keys (every non-literal element access and every computed non-literal key, in
// object literals AND destructuring patterns, is rejected); string-literal '__proto__' keys in patterns are
// caught; Object.getOwnPropertyDescriptor(s) and __lookupGetter__/__lookupSetter__ are denied; `with` is
// rejected; and *.test.ts files cannot be imported by production code (the import allow-list has no
// extension forms). Name-based and scope-insensitive: a guard against drift, not a sandbox. Out of reach:
// transitive imports (a permitted module that itself does something unsafe) and test files, which are
// not analysed (they may import vitest and fs), but their names are allow-listed.
//
// Rules deliberately NOT written here (their subject does not exist yet): the "terminalHub.ts and main.ts are
// the only pty-manager importers" rule (V2, needs terminalHub) and "the phone path touches only
// permissionBroker.respond" (V5, needs the broker). The permissionServer shape (single listen on 127.0.0.1)
// is already pinned by LISTEN_ALLOWLIST in noWildcardListener.test.ts, and that file's wildcard and listen
// scans already cover electron/control/ because they walk all of electron/.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const REPO = path.resolve(__dirname, '../..');
const CONTROL_REL = 'electron/control';
const CONTROL_DIR = path.join(REPO, CONTROL_REL);

type Rule = 'syntax' | 'module' | 'escape' | 'write' | 'input' | 'protocol' | 'log' | 'listen' | 'file';
const ALL_RULES: readonly Rule[] = ['syntax', 'module', 'escape', 'write', 'input', 'protocol', 'log', 'listen', 'file'];
interface Violation { rule: Rule; msg: string }
interface Facts { sinks: number; handled: string[] | null; declared: string[] | null }
interface Analysis { violations: Violation[]; facts: Facts }

// The five production files the design names; a sixth is a reviewed edit to this list.
const OWN_FILES = ['protocol', 'controlGateway', 'inputRouter', 'controlHub', 'controlIpc'] as const;
const ALLOWED_NAMES: ReadonlySet<string> = new Set([
  ...OWN_FILES.flatMap((f) => [`${f}.ts`, `${f}.test.ts`]),
  'controlBoundary.test.ts',
]);
const RESERVED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.worktrees', 'dist', 'dist-electron', 'release']);

/** Import allow-list, keyed by repo-relative path without extension. typeOnly: only `import type` forms are permitted. */
function allowedImports(file: string): Map<string, { typeOnly: boolean }> {
  const m = new Map<string, { typeOnly: boolean }>();
  for (const f of OWN_FILES) m.set(`${CONTROL_REL}/${f}`, { typeOnly: false });
  m.set('electron/permissionBroker', { typeOnly: true });
  m.set('electron/terminalHub', { typeOnly: true });
  m.set('electron', { typeOnly: true });
  m.set('src/shared/remote/types', { typeOnly: false });
  m.set('src/shared/board/text', { typeOnly: false }); // maskSecrets
  // controlHub owns the device auth instance and store (design 5.1), which are the parametrised remote modules.
  if (file === 'controlHub.ts') {
    m.set('electron/remote/remoteAuth', { typeOnly: false });
    m.set('electron/remote/sessionStore', { typeOnly: false });
  }
  return m;
}

// Specific rule-1 categories, reported in addition to the allow-list so a failure names the real problem.
const FORBIDDEN_MODULE = /^(?:node:)?(?:child_process|http|https|net|ws|fs|fs\/promises|worker_threads|vm|dgram|tls|http2|cluster)$|node-pty|ptyManager|codexPtyManager|ptyLifecycle|permissionServer|communicationBridge/;
const DENY_IDENT: ReadonlySet<string> = new Set(['createRequire', 'eval', 'Function', 'globalThis', 'global', 'module', 'Reflect', 'require', 'process']);
const DENY_PROP: ReadonlySet<string> = new Set([
  'createRequire', 'getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'mainModule', 'require', 'kill', 'constructor', 'report',
  '__proto__', 'prototype', 'getPrototypeOf', 'setPrototypeOf', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
]);
const PROTO_NAMES: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'getPrototypeOf', 'setPrototypeOf', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
const OBJECT_ESCAPES: ReadonlySet<string> = new Set(['defineProperty', 'defineProperties', 'assign', 'create', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors']);
const WRITE_NAMES: ReadonlySet<string> = new Set([
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'rename', 'renameSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'mkdir', 'mkdirSync', 'truncate', 'truncateSync',
  'symlink', 'symlinkSync', 'chmod', 'chmodSync', 'writeSync', 'writev', 'writevSync',
]);
const LISTEN_NAMES: ReadonlySet<string> = new Set(['listen', 'createServer']);
const LOGGERS: ReadonlySet<string> = new Set(['diag', 'logDiag', 'log']);
const SECRET_NAME = /token|secret|bearer|cookie|pairing|^code$|paircode/i;
const INPUT_VALIDATOR = 'validateInput'; // the protocol.ts validator whose output inputRouter may write; rename here and in protocol.ts together.
const SINK_RECEIVER = 'terminals'; // the injected terminalHub handle in inputRouter.ts

type StrLit = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;
const isStrLit = (n: ts.Node | undefined): n is StrLit => !!n && (n.kind === ts.SyntaxKind.StringLiteral || n.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral);
const keyText = (n: ts.Node | undefined): string | null => (n && (ts.isIdentifier(n) || isStrLit(n)) ? n.text : null);
/** Key text, also seeing through a computed key that holds a plain string literal. */
const keyName = (n: ts.Node | undefined): string | null => (n && ts.isComputedPropertyName(n) && isStrLit(n.expression) ? n.expression.text : keyText(n));
function memberName(n: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n) && isStrLit(n.argumentExpression)) return n.argumentExpression.text;
  return null;
}
function isReference(n: ts.Identifier): boolean {
  const p = n.parent;
  if (!p) return true;
  if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
  if (ts.isQualifiedName(p) && p.right === n) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isPropertyDeclaration(p) ||
       ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p)) && p.name === n) return false;
  if (ts.isBindingElement(p) && p.propertyName === n) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return true;
}
function visit(node: ts.Node, fn: (n: ts.Node) => void): void { fn(node); ts.forEachChild(node, (c) => visit(c, fn)); }
function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isNonNullExpression(x) || ts.isTypeAssertionExpression(x)) x = x.expression;
  return x;
}

interface Ref { spec: string | null; form: string; typeOnly: boolean }
function moduleRefs(sf: ts.SourceFile): Ref[] {
  const refs: Ref[] = [];
  visit(sf, (n) => {
    if (ts.isImportDeclaration(n)) {
      const c = n.importClause;
      const named = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings : null;
      // `import { type A, type B }` is erased too, but only when there is no default and no namespace import.
      const allTypeNamed = !!c && !c.name && !!named && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
      refs.push({ spec: isStrLit(n.moduleSpecifier) ? n.moduleSpecifier.text : null, form: c ? 'import' : 'side-effect import', typeOnly: !!c && (c.isTypeOnly || allTypeNamed) });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      refs.push({ spec: isStrLit(n.moduleSpecifier) ? n.moduleSpecifier.text : null, form: 'export-from', typeOnly: n.isTypeOnly });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const e = n.moduleReference.expression;
      refs.push({ spec: isStrLit(e) ? e.text : null, form: 'import-equals', typeOnly: n.isTypeOnly });
    } else if (ts.isCallExpression(n) && ((ts.isIdentifier(n.expression) && n.expression.text === 'require') || n.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      const a = n.arguments;
      refs.push({ spec: a.length === 1 && isStrLit(a[0]) ? a[0].text : null, form: n.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic import' : 'require', typeOnly: false });
    } else if (ts.isImportTypeNode(n)) {
      const l = n.argument;
      refs.push({ spec: ts.isLiteralTypeNode(l) && isStrLit(l.literal) ? l.literal.text : null, form: 'import-type', typeOnly: true });
    }
  });
  return refs;
}

/** Repo-relative, extension-less key for a specifier, or the bare specifier itself for packages and builtins. */
function resolveSpec(spec: string): string {
  return spec.startsWith('.') ? path.posix.normalize(path.posix.join(CONTROL_REL, spec)) : spec;
}

const isComparison = (k: ts.SyntaxKind): boolean =>
  k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsEqualsToken || k === ts.SyntaxKind.EqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsToken;

/** Analyse one production file of electron/control. `name` is the bare file name (`inputRouter.ts`). */
function analyzeControl(name: string, text: string): Analysis {
  const found = new Map<string, Violation>();
  const v = (rule: Rule, msg: string): void => { found.set(`${rule}:${msg}`, { rule, msg }); };
  const kind = /\.(?:mjs|js)$/.test(name) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind);
  const diags = ts.transpileModule(text, { fileName: name, reportDiagnostics: true, compilerOptions: { allowJs: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, isolatedModules: true } }).diagnostics ?? [];
  for (const d of diags) if (d.category === ts.DiagnosticCategory.Error) v('syntax', 'syntax error (cannot prove the file safe): ' + ts.flattenDiagnosticMessageText(d.messageText, ' '));

  // ---- rules 1 and 4: imports ----
  const allowed = allowedImports(name);
  for (const r of moduleRefs(sf)) {
    if (r.spec === null) { v('module', `dynamic module specifier (${r.form})`); continue; }
    const bare = r.spec.replace(/^node:/, '');
    if (FORBIDDEN_MODULE.test(r.spec) || FORBIDDEN_MODULE.test(bare)) v('module', `forbidden module (${r.form}): ${r.spec}`);
    if (r.spec === 'electron' && !r.typeOnly) v('module', `electron value import (${r.form})`);
    const hit = allowed.get(resolveSpec(r.spec));
    if (!hit) v('module', `import not on the electron/control allow-list (${r.form}): ${r.spec}`);
    else if (hit.typeOnly && !r.typeOnly) v('module', `${r.spec} may be imported as a type only (${r.form})`);
  }

  // ---- node walk ----
  const sinks: ts.CallExpression[] = [];
  const declCount = new Map<string, number>();
  const validated = new Set<string>();
  const handled = new Set<string>();
  visit(sf, (n) => {
    // names declared (for shadowing detection of the validated binding)
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name)) declCount.set(n.name.text, (declCount.get(n.name.text) ?? 0) + 1);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.getCombinedNodeFlags(n) & ts.NodeFlags.Const) !== 0) {
      const init = unwrap(n.initializer);
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === INPUT_VALIDATOR) validated.add(n.name.text);
    }
    if (ts.isIdentifier(n)) {
      const t = n.text;
      const ref = isReference(n);
      if (PROTO_NAMES.has(t)) v('escape', `prototype access: ${t}`);
      if (ref && DENY_IDENT.has(t) && !ts.isImportSpecifier(n.parent)) v('escape', `escape-hatch identifier: ${t}`);
      if (WRITE_NAMES.has(t)) v('write', `write-capable name: ${t}`);
      if (LISTEN_NAMES.has(t)) v('listen', `${t} named in electron/control (the only listener is electron/remote/remoteServer.ts)`);
      if (ref && t === 'console') v('log', 'console used (log through the metadata-only diag helper)');
    }
    if (ts.isWithStatement(n)) v('escape', 'with statement');
    // keys: object literals, patterns, members
    if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n) || ts.isMethodDeclaration(n) || ts.isBindingElement(n) || ts.isPropertyDeclaration(n)) {
      const keyNode = ts.isBindingElement(n) ? (n.propertyName ?? n.name) : n.name;
      if (keyNode && ts.isComputedPropertyName(keyNode) && !isStrLit(keyNode.expression)) v('escape', 'computed non-literal key (object, class or destructuring pattern)');
      const k = keyName(keyNode);
      if (k !== null) {
        if (PROTO_NAMES.has(k) || k === 'constructor') v('escape', `prototype or constructor key: ${k}`);
        if (k === 'write') v('write', 'write named as an object, class or destructuring key');
        if (LISTEN_NAMES.has(k)) v('listen', `${k} named as a key`);
        if (name === 'controlGateway.ts' && k === 't' && ts.isBindingElement(n)) v('protocol', 'message type destructured out of the frame (read it as msg.t in a switch or comparison)');
      }
    }
    if (ts.isElementAccessExpression(n)) {
      if (!(isStrLit(n.argumentExpression) || ts.isNumericLiteral(n.argumentExpression))) v('escape', 'element access with a non-literal key');
    }
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Object' && OBJECT_ESCAPES.has(n.name.text)) v('escape', `Object.${n.name.text}`);
      const m = memberName(n);
      if (m !== null) {
        if (DENY_PROP.has(m)) v('escape', `denied member: .${m}`);
        if (LISTEN_NAMES.has(m)) v('listen', `.${m} reached in electron/control`);
        if (WRITE_NAMES.has(m) && ts.isElementAccessExpression(n)) v('write', `write-capable name (element access): ${m}`);
        if (m === 'write') {
          // rule 2: the only terminal write sink is `terminals.write(<validated input>)` inside inputRouter.ts, called directly.
          const recv = n.expression;
          const direct = ts.isPropertyAccessExpression(n) && ts.isCallExpression(n.parent) && n.parent.expression === n && !n.questionDotToken && !n.parent.questionDotToken;
          if (name !== 'inputRouter.ts') v('write', `.write outside inputRouter.ts`);
          else if (!direct || !ts.isIdentifier(recv) || recv.text !== SINK_RECEIVER) v('write', `.write must be a direct ${SINK_RECEIVER}.write(...) call (no alias, bind, call, apply or element access)`);
          else sinks.push(n.parent as ts.CallExpression);
        }
        if (m === 't' && name === 'controlGateway.ts') {
          const p = n.parent;
          if (ts.isPropertyAccessExpression(n) && ts.isSwitchStatement(p) && p.expression === n) {
            for (const c of p.caseBlock.clauses) {
              if (!ts.isCaseClause(c)) continue;
              if (isStrLit(c.expression)) handled.add(c.expression.text);
              else v('protocol', 'case label is not a string literal');
            }
          } else if (ts.isBinaryExpression(p) && isComparison(p.operatorToken.kind) && ts.isPropertyAccessExpression(n)) {
            const other = p.left === n ? p.right : p.left;
            if (isStrLit(other)) handled.add(other.text);
            else v('protocol', 'message type compared with a non-literal');
          } else v('protocol', 'message type .t used other than as a switch subject or ===/!== comparison with a literal');
        }
      }
    }
    if (isStrLit(n) && /pty:write/.test(n.text)) v('write', 'pty:write string');
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const callee = n.expression.text;
      if (LOGGERS.has(callee)) {
        for (const arg of n.arguments) {
          visit(arg, (x) => { if (ts.isIdentifier(x) && SECRET_NAME.test(x.text)) v('log', `secret-named value passed to ${callee}(): ${x.text}`); });
        }
      }
    }
  });

  // rule 2, continued: what the sink writes
  if (name === 'inputRouter.ts') {
    for (const call of sinks) {
      const last = call.arguments[call.arguments.length - 1];
      const arg = last ? unwrap(last) : undefined;
      const direct = !!arg && ts.isCallExpression(arg) && ts.isIdentifier(arg.expression) && arg.expression.text === INPUT_VALIDATOR;
      const viaBinding = !!arg && ts.isIdentifier(arg) && validated.has(arg.text) && declCount.get(arg.text) === 1;
      if (!direct && !viaBinding) v('input', `${SINK_RECEIVER}.write data must be the output of ${INPUT_VALIDATOR}() (a call, or a const bound to one and declared once)`);
    }
  }

  // rule 3 inputs: the declared list in protocol.ts
  let declared: string[] | null = null;
  if (name === 'protocol.ts') {
    visit(sf, (n) => {
      if (!(ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'MESSAGE_TYPES' && n.initializer)) return;
      const obj = unwrap(n.initializer);
      const prop = ts.isObjectLiteralExpression(obj) ? obj.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && keyText(p.name) === 'phoneToTitan') : undefined;
      const arr = prop ? unwrap(prop.initializer) : undefined;
      if (arr && ts.isArrayLiteralExpression(arr) && arr.elements.every(isStrLit)) declared = arr.elements.map((e) => (e as StrLit).text);
    });
    if (declared === null) v('protocol', 'MESSAGE_TYPES.phoneToTitan must be a statically readable array of string literals');
    else if (new Set<string>(declared).size !== (declared as string[]).length) v('protocol', 'duplicate entry in MESSAGE_TYPES.phoneToTitan');
  }
  return { violations: [...found.values()], facts: { sinks: sinks.length, handled: name === 'controlGateway.ts' ? [...handled].sort() : null, declared } };
}

/** Rule 3: handled message types equal the declared allow-list. Absent together is pending; one without the other is a violation. */
function crossCheck(a: ReadonlyMap<string, Analysis>): Violation[] {
  const gw = a.get('controlGateway.ts');
  const pr = a.get('protocol.ts');
  if (!gw && !pr) return [];
  if (!gw || !pr) return [{ rule: 'protocol', msg: 'controlGateway.ts and protocol.ts must exist together' }];
  const declared = pr.facts.declared;
  if (declared === null) return []; // protocol.ts already reports why
  const handled = gw.facts.handled ?? [];
  const want = [...declared].sort();
  const missing = want.filter((t) => !handled.includes(t));
  const extra = handled.filter((t) => !want.includes(t));
  return missing.length || extra.length ? [{ rule: 'protocol', msg: `handled message types differ from MESSAGE_TYPES.phoneToTitan (unhandled: [${missing}], undeclared: [${extra}])` }] : [];
}

/** Scan a control directory (real or scratch). A missing directory is a valid, explicit "not built yet" state. */
function scanControlDir(dir: string): { exists: boolean; files: string[]; violations: string[] } {
  if (!fs.existsSync(dir)) return { exists: false, files: [], violations: [] };
  const files: string[] = [];
  const out: string[] = [];
  const analyses = new Map<string, Analysis>();
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (RESERVED_DIRS.has(e.name)) { out.push(`${e.name}: [file] reserved directory name`); continue; }
    if (e.isSymbolicLink()) { out.push(`${e.name}: [file] symlink`); continue; }
    if (e.isDirectory()) { out.push(`${e.name}/: [file] subdirectory (electron/control is flat)`); continue; }
    files.push(e.name);
    if (!ALLOWED_NAMES.has(e.name)) { out.push(`${e.name}: [file] not on the file allow-list`); continue; }
    if (e.name.endsWith('.test.ts')) continue;
    const a = analyzeControl(e.name, fs.readFileSync(path.join(dir, e.name), 'utf8'));
    analyses.set(e.name, a);
    for (const x of a.violations) out.push(`${e.name}: [${x.rule}] ${x.msg}`);
  }
  for (const x of crossCheck(analyses)) out.push(`(cross): [${x.rule}] ${x.msg}`);
  return { exists: true, files: files.sort(), violations: out };
}

// ---------------------------------------------------------------------------------------------
// Fixtures. CLEAN must produce zero violations; each BAD row must produce its rule (and the substring).
// ---------------------------------------------------------------------------------------------
interface Row { id: string; file: string; src: string }
interface Bad extends Row { rule: Rule; has: string }

const CLEAN: Row[] = [
  { id: 'protocol', file: 'protocol.ts', src: "export const MESSAGE_TYPES = { phoneToTitan: ['hello', 'attach', 'in'] } as const;\nexport function validateInput(x: unknown): string { return String(x); }" },
  { id: 'gateway', file: 'controlGateway.ts', src: "import type { PermissionBroker } from '../permissionBroker';\nimport { maskSecrets } from '../../src/shared/board/text';\nimport { MESSAGE_TYPES } from './protocol';\nexport function handle(msg: { t: string }): string { switch (msg.t) { case 'hello': return maskSecrets('a'); case 'attach': return 'b'; default: return MESSAGE_TYPES.phoneToTitan[0]; } }\nexport type P = PermissionBroker;" },
  { id: 'router-binding', file: 'inputRouter.ts', src: "import type { TerminalHub } from '../terminalHub';\nimport { validateInput } from './protocol';\nexport function route(terminals: TerminalHub, raw: unknown): void { const data = validateInput(raw); terminals.write(0, data); }" },
  { id: 'router-direct', file: 'inputRouter.ts', src: "import { validateInput } from './protocol';\nexport const route = (terminals: { write(s: number, d: string): void }, raw: unknown): void => { terminals.write(1, validateInput(raw)); };" },
  { id: 'hub', file: 'controlHub.ts', src: "import { RemoteAuth } from '../remote/remoteAuth';\nimport { loadSessions } from '../remote/sessionStore';\nexport const hub = (a: RemoteAuth): void => { void loadSessions; void a; };" },
  { id: 'ipc', file: 'controlIpc.ts', src: "import type { IpcMain } from 'electron';\nimport type { ControlStatus } from '../../src/shared/remote/types';\nimport { type TerminalHub } from '../terminalHub';\nexport const wire = (ipc: IpcMain, s: ControlStatus, h: TerminalHub): void => { void ipc; void s; void h; };" },
  { id: 'comments-and-strings', file: 'controlGateway.ts', src: "// import fs from 'fs'; eval(x); terminals.write(1, raw);\nexport const note = \"child_process require('fs') 0.0.0.0\";" },
];
const BAD: Bad[] = [
  // rule 1: forbidden imports, every syntax form
  { id: 'cp-import', file: 'controlGateway.ts', src: "import { spawn } from 'child_process';\nspawn('x');", rule: 'module', has: 'forbidden module' },
  { id: 'cp-node-prefix', file: 'controlGateway.ts', src: "import * as cp from 'node:child_process';\nvoid cp;", rule: 'module', has: 'forbidden module' },
  { id: 'cp-require', file: 'controlGateway.ts', src: "const c = require('child_process');\nvoid c;", rule: 'module', has: 'forbidden module' },
  { id: 'cp-dynamic', file: 'controlGateway.ts', src: "export const l = () => import('child_process');", rule: 'module', has: 'forbidden module' },
  { id: 'cp-import-equals', file: 'controlGateway.ts', src: "import cp = require('child_process');\nvoid cp;", rule: 'module', has: 'forbidden module' },
  { id: 'cp-export-from', file: 'controlGateway.ts', src: "export { spawn } from 'child_process';", rule: 'module', has: 'forbidden module' },
  { id: 'cp-import-type-node', file: 'controlGateway.ts', src: "export type T = import('child_process').ChildProcess;", rule: 'module', has: 'forbidden module' },
  { id: 'dynamic-spec', file: 'controlGateway.ts', src: "const m = 'child_' + 'process';\nexport const l = () => import(m);", rule: 'module', has: 'dynamic module specifier' },
  { id: 'node-pty', file: 'controlGateway.ts', src: "import * as pty from 'node-pty';\nvoid pty;", rule: 'module', has: 'node-pty' },
  { id: 'pty-manager', file: 'controlGateway.ts', src: "import { PtyManager } from '../ptyManager';\nvoid PtyManager;", rule: 'module', has: 'ptyManager' },
  { id: 'codex-pty-manager', file: 'controlHub.ts', src: "import { x } from '../codexPtyManager';\nvoid x;", rule: 'module', has: 'codexPtyManager' },
  { id: 'pty-lifecycle', file: 'controlHub.ts', src: "import { x } from '../ptyLifecycle';\nvoid x;", rule: 'module', has: 'ptyLifecycle' },
  { id: 'http', file: 'controlHub.ts', src: "import http from 'http';\nvoid http;", rule: 'module', has: 'forbidden module' },
  { id: 'https-node', file: 'controlHub.ts', src: "import https from 'node:https';\nvoid https;", rule: 'module', has: 'forbidden module' },
  { id: 'net', file: 'controlHub.ts', src: "import net from 'net';\nvoid net;", rule: 'module', has: 'forbidden module' },
  { id: 'ws', file: 'controlHub.ts', src: "import { WebSocketServer } from 'ws';\nvoid WebSocketServer;", rule: 'module', has: 'forbidden module' },
  { id: 'fs', file: 'controlHub.ts', src: "import fs from 'fs';\nvoid fs;", rule: 'module', has: 'forbidden module' },
  { id: 'fs-promises', file: 'controlHub.ts', src: "import { readFile } from 'node:fs/promises';\nvoid readFile;", rule: 'module', has: 'forbidden module' },
  { id: 'electron-value', file: 'controlIpc.ts', src: "import { ipcMain } from 'electron';\nvoid ipcMain;", rule: 'module', has: 'electron value import' },
  { id: 'electron-default', file: 'controlIpc.ts', src: "import electron from 'electron';\nvoid electron;", rule: 'module', has: 'electron value import' },
  { id: 'electron-side-effect', file: 'controlIpc.ts', src: "import 'electron';", rule: 'module', has: 'electron value import' },
  // rule 4: allow-list
  { id: 'bridge', file: 'controlGateway.ts', src: "import { send } from '../communicationBridge/bridge';\nvoid send;", rule: 'module', has: 'communicationBridge' },
  { id: 'permission-server', file: 'controlGateway.ts', src: "import { start } from '../permissionServer';\nvoid start;", rule: 'module', has: 'permissionServer' },
  { id: 'main', file: 'controlGateway.ts', src: "import { win } from '../main';\nvoid win;", rule: 'module', has: 'allow-list' },
  { id: 'settings', file: 'controlGateway.ts', src: "import { getSetting } from '../../src/state/persistence';\nvoid getSetting;", rule: 'module', has: 'allow-list' },
  { id: 'remote-server', file: 'controlHub.ts', src: "import { RemoteServer } from '../remote/remoteServer';\nvoid RemoteServer;", rule: 'module', has: 'allow-list' },
  { id: 'remote-auth-from-gateway', file: 'controlGateway.ts', src: "import { RemoteAuth } from '../remote/remoteAuth';\nvoid RemoteAuth;", rule: 'module', has: 'allow-list' },
  { id: 'broker-value', file: 'controlGateway.ts', src: "import { broker } from '../permissionBroker';\nvoid broker;", rule: 'module', has: 'type only' },
  { id: 'hub-value', file: 'controlGateway.ts', src: "import { terminalHub } from '../terminalHub';\nvoid terminalHub;", rule: 'module', has: 'type only' },
  { id: 'hub-side-effect', file: 'controlGateway.ts', src: "import '../terminalHub';", rule: 'module', has: 'type only' },
  { id: 'test-file-import', file: 'controlGateway.ts', src: "import './inputRouter.test';", rule: 'module', has: 'allow-list' },
  { id: 'ts-extension', file: 'controlGateway.ts', src: "import { a } from './protocol.ts';\nvoid a;", rule: 'module', has: 'allow-list' },
  { id: 'sibling-unknown', file: 'controlGateway.ts', src: "import { a } from './extra';\nvoid a;", rule: 'module', has: 'allow-list' },
  { id: 'escape-dir', file: 'controlGateway.ts', src: "import { a } from '../control/../main';\nvoid a;", rule: 'module', has: 'allow-list' },
  // rule 2: the one input sink
  { id: 'write-in-gateway', file: 'controlGateway.ts', src: "export const f = (pty: { write(s: string): void }) => { pty.write('x'); };", rule: 'write', has: 'outside inputRouter.ts' },
  { id: 'write-in-hub', file: 'controlHub.ts', src: "export const f = (terminals: { write(s: string): void }) => { terminals.write('x'); };", rule: 'write', has: 'outside inputRouter.ts' },
  { id: 'write-pty-ipc-string', file: 'controlIpc.ts', src: "export const ch = 'pty:write';", rule: 'write', has: 'pty:write' },
  { id: 'write-unvalidated', file: 'inputRouter.ts', src: "export const r = (terminals: { write(s: number, d: string): void }, raw: string): void => { terminals.write(0, raw); };", rule: 'input', has: 'validateInput' },
  { id: 'write-wrong-receiver', file: 'inputRouter.ts', src: "import { validateInput } from './protocol';\nexport const r = (pty: { write(s: number, d: string): void }, raw: string): void => { pty.write(0, validateInput(raw)); };", rule: 'write', has: 'direct terminals.write' },
  { id: 'write-alias', file: 'inputRouter.ts', src: "export const r = (terminals: { write: () => void }): void => { const w = terminals.write; w(); };", rule: 'write', has: 'direct terminals.write' },
  { id: 'write-call', file: 'inputRouter.ts', src: "import { validateInput } from './protocol';\nexport const r = (terminals: { write: (a: number, b: string) => void }, raw: string): void => { terminals.write.call(terminals, 0, validateInput(raw)); };", rule: 'write', has: 'direct terminals.write' },
  { id: 'write-element', file: 'inputRouter.ts', src: "export const r = (terminals: Record<string, (d: string) => void>): void => { terminals['write']('x'); };", rule: 'write', has: 'direct terminals.write' },
  { id: 'write-destructure', file: 'inputRouter.ts', src: "export const r = (terminals: { write: () => void }): void => { const { write } = terminals; write(); };", rule: 'write', has: 'destructuring key' },
  { id: 'write-optional-chain', file: 'inputRouter.ts', src: "import { validateInput } from './protocol';\nexport const r = (terminals: { write?: (a: number, b: string) => void }, raw: string): void => { terminals.write?.(0, validateInput(raw)); };", rule: 'write', has: 'direct terminals.write' },
  { id: 'write-shadowed-binding', file: 'inputRouter.ts', src: "import { validateInput } from './protocol';\nexport const r = (terminals: { write(s: number, d: string): void }, raw: string): void => { const d = validateInput(raw); { const d = raw; terminals.write(0, d); } void d; };", rule: 'input', has: 'validateInput' },
  { id: 'write-let-binding', file: 'inputRouter.ts', src: "import { validateInput } from './protocol';\nexport const r = (terminals: { write(s: number, d: string): void }, raw: string): void => { let d = validateInput(raw); d = raw; terminals.write(0, d); };", rule: 'input', has: 'validateInput' },
  { id: 'kill', file: 'controlGateway.ts', src: "export const k = (h: { kill(): void }) => { h.kill(); };", rule: 'escape', has: '.kill' },
  { id: 'fs-write-name', file: 'controlHub.ts', src: "export const w = (s: { writeFileSync: () => void }) => { s.writeFileSync(); };", rule: 'write', has: 'writeFileSync' },
  // rule 3: closed message set (single-file shapes; set equality is in CROSS below)
  { id: 'gateway-compare-nonliteral', file: 'controlGateway.ts', src: "export const f = (m: { t: string }, k: string) => m.t === k;", rule: 'protocol', has: 'non-literal' },
  { id: 'gateway-t-lookup', file: 'controlGateway.ts', src: "export const f = (m: { t: string }, h: Record<string, () => void>) => h[m.t];", rule: 'protocol', has: 'used other than' },
  { id: 'gateway-t-destructure', file: 'controlGateway.ts', src: "export const f = (m: { t: string }) => { const { t } = m; return t; };", rule: 'protocol', has: 'destructured' },
  { id: 'gateway-t-passed', file: 'controlGateway.ts', src: "declare function use(x: string): void;\nexport const f = (m: { t: string }) => { use(m.t); };", rule: 'protocol', has: 'used other than' },
  { id: 'gateway-case-nonliteral', file: 'controlGateway.ts', src: "export const f = (m: { t: string }, k: string) => { switch (m.t) { case k: return 1; default: return 0; } };", rule: 'protocol', has: 'case label' },
  { id: 'protocol-not-static', file: 'protocol.ts', src: "const base = ['hello'];\nexport const MESSAGE_TYPES = { phoneToTitan: [...base] } as const;", rule: 'protocol', has: 'statically readable' },
  { id: 'protocol-missing', file: 'protocol.ts', src: "export const OTHER = 1;", rule: 'protocol', has: 'statically readable' },
  { id: 'protocol-duplicate', file: 'protocol.ts', src: "export const MESSAGE_TYPES = { phoneToTitan: ['hello', 'hello'] } as const;", rule: 'protocol', has: 'duplicate' },
  // escape hatches (including the PR #127 known gaps, which are NOT copied here)
  { id: 'eval', file: 'controlHub.ts', src: "export const e = (s: string) => eval(s);", rule: 'escape', has: 'eval' },
  { id: 'new-function', file: 'controlHub.ts', src: "export const e = (s: string) => new Function(s);", rule: 'escape', has: 'Function' },
  { id: 'reflect', file: 'controlHub.ts', src: "export const e = (o: object) => Reflect.ownKeys(o);", rule: 'escape', has: 'Reflect' },
  { id: 'globalthis', file: 'controlHub.ts', src: "export const e = () => globalThis;", rule: 'escape', has: 'globalThis' },
  { id: 'process', file: 'controlHub.ts', src: "export const e = () => process.env;", rule: 'escape', has: 'process' },
  { id: 'process-binding', file: 'controlHub.ts', src: "export const e = (p: { binding(s: string): void }) => p.binding('fs');", rule: 'escape', has: '.binding' },
  { id: 'require-bare', file: 'controlHub.ts', src: "export const e = (r: unknown) => require;", rule: 'escape', has: 'require' },
  { id: 'constructor', file: 'controlHub.ts', src: "export const e = (o: object) => o.constructor;", rule: 'escape', has: 'constructor' },
  { id: 'proto', file: 'controlHub.ts', src: "export const e = (o: object) => o.__proto__;", rule: 'escape', has: '__proto__' },
  { id: 'element-dynamic', file: 'controlHub.ts', src: "export const e = (o: Record<string, number>, k: string) => o[k];", rule: 'escape', has: 'non-literal key' },
  { id: 'element-concat', file: 'controlHub.ts', src: "export const e = (o: Record<string, () => void>) => o['wr' + 'ite']();", rule: 'escape', has: 'non-literal key' },
  { id: 'pattern-computed-key', file: 'controlHub.ts', src: "export const e = (o: Record<string, number>, k: string) => { const { [k]: v } = o; return v; };", rule: 'escape', has: 'computed non-literal key' },
  { id: 'pattern-proto-key', file: 'controlHub.ts', src: "export const e = (o: Record<string, number>) => { const { '__proto__': p } = o; return p; };", rule: 'escape', has: '__proto__' },
  { id: 'object-literal-computed', file: 'controlHub.ts', src: "export const e = (k: string) => ({ [k]: 1 });", rule: 'escape', has: 'computed non-literal key' },
  { id: 'assign-pattern-computed', file: 'controlHub.ts', src: "export const e = (o: Record<string, number>, k: string) => { let v = 0; ({ [k]: v } = o); return v; };", rule: 'escape', has: 'computed non-literal key' },
  { id: 'get-own-descriptor', file: 'controlHub.ts', src: "export const e = (o: object) => Object.getOwnPropertyDescriptor(o, 'x');", rule: 'escape', has: 'getOwnPropertyDescriptor' },
  { id: 'lookup-getter', file: 'controlHub.ts', src: "export const e = (o: { __lookupGetter__(s: string): void }) => o.__lookupGetter__('x');", rule: 'escape', has: '__lookupGetter__' },
  { id: 'object-define', file: 'controlHub.ts', src: "export const e = (o: object) => Object.defineProperty(o, 'x', {});", rule: 'escape', has: 'defineProperty' },
  { id: 'with-statement', file: 'controlHub.ts', src: "export function e(o: object) { with (o) { return 1; } }", rule: 'escape', has: 'with statement' },
  // listeners
  { id: 'listen-call', file: 'controlHub.ts', src: "export const l = (s: { listen(p: number): void }) => { s.listen(1); };", rule: 'listen', has: 'listen' },
  { id: 'listen-destructure', file: 'controlHub.ts', src: "export const l = (s: { listen: () => void }) => { const { listen } = s; listen(); };", rule: 'listen', has: 'listen' },
  { id: 'create-server-element', file: 'controlHub.ts', src: "export const l = (h: Record<string, () => void>) => h['createServer']();", rule: 'listen', has: 'createServer' },
  // rule 7: nothing secret to a log, no console
  { id: 'console', file: 'controlHub.ts', src: "export const l = () => console.log('x');", rule: 'log', has: 'console' },
  { id: 'diag-token', file: 'controlHub.ts', src: "declare function diag(s: string): void;\nexport const l = (token: string) => diag(`paired ${token}`);", rule: 'log', has: 'token' },
  { id: 'diag-code', file: 'controlHub.ts', src: "declare function diag(s: string): void;\nexport const l = (pairingCode: string) => diag('x' + pairingCode);", rule: 'log', has: 'pairingCode' },
  // syntax
  { id: 'syntax-error', file: 'controlHub.ts', src: "export const = ;", rule: 'syntax', has: 'cannot prove' },
];

const CROSS: Array<{ id: string; files: Record<string, string>; expectViolation: boolean; has?: string }> = [
  { id: 'both-absent', files: {}, expectViolation: false },
  {
    id: 'equal-sets', expectViolation: false,
    files: {
      'protocol.ts': "export const MESSAGE_TYPES = { phoneToTitan: ['hello', 'in'] } as const;",
      'controlGateway.ts': "export const f = (m: { t: string }) => { switch (m.t) { case 'in': return 1; case 'hello': return 2; default: return 0; } };",
    },
  },
  {
    id: 'equal-sets-comparisons', expectViolation: false,
    files: {
      'protocol.ts': "export const MESSAGE_TYPES = { phoneToTitan: ['hello', 'in'] } as const;",
      'controlGateway.ts': "export const f = (m: { t: string }) => m.t === 'hello' || m.t === 'in';",
    },
  },
  {
    id: 'new-verb-in-gateway', expectViolation: true, has: 'undeclared: [kill]',
    files: {
      'protocol.ts': "export const MESSAGE_TYPES = { phoneToTitan: ['hello'] } as const;",
      'controlGateway.ts': "export const f = (m: { t: string }) => { switch (m.t) { case 'hello': return 1; case 'kill': return 2; default: return 0; } };",
    },
  },
  {
    id: 'new-verb-by-comparison', expectViolation: true, has: 'undeclared: [kill]',
    files: {
      'protocol.ts': "export const MESSAGE_TYPES = { phoneToTitan: ['hello'] } as const;",
      'controlGateway.ts': "export const f = (m: { t: string }) => m.t === 'hello' || m.t === 'kill';",
    },
  },
  {
    id: 'declared-not-handled', expectViolation: true, has: 'unhandled: [in]',
    files: {
      'protocol.ts': "export const MESSAGE_TYPES = { phoneToTitan: ['hello', 'in'] } as const;",
      'controlGateway.ts': "export const f = (m: { t: string }) => m.t === 'hello';",
    },
  },
  {
    id: 'gateway-without-protocol', expectViolation: true, has: 'exist together',
    files: { 'controlGateway.ts': "export const f = (m: { t: string }) => m.t === 'hello';" },
  },
  {
    id: 'protocol-without-gateway', expectViolation: true, has: 'exist together',
    files: { 'protocol.ts': "export const MESSAGE_TYPES = { phoneToTitan: ['hello'] } as const;" },
  },
  {
    id: 'gateway-handles-nothing', expectViolation: true, has: 'unhandled: [hello]',
    files: {
      'protocol.ts': "export const MESSAGE_TYPES = { phoneToTitan: ['hello'] } as const;",
      'controlGateway.ts': "export const f = (): number => 1;",
    },
  },
];

const fmt = (a: Analysis): string[] => a.violations.map((x) => `[${x.rule}] ${x.msg}`);

describe('phone control: real electron/control tree', () => {
  const scan = scanControlDir(CONTROL_DIR);

  it('electron/control has no violations (a missing directory is the explicit not-built-yet state, not a skipped check)', () => {
    expect(scan.violations).toEqual([]);
    // State is asserted, never implied: either the directory is absent, or every file in it is on the allow-list.
    if (!scan.exists) expect(scan.files).toEqual([]);
    else expect(scan.files.filter((f) => !ALLOWED_NAMES.has(f))).toEqual([]);
  });

  it('the scan really reaches the repo (resolved from this file, not the cwd)', () => {
    expect(fs.existsSync(path.join(REPO, 'electron/remote/noWildcardListener.test.ts'))).toBe(true);
    expect(path.relative(REPO, CONTROL_DIR).replace(/\\/g, '/')).toBe(CONTROL_REL);
  });
});

describe('phone control: the rules are live (engine fixtures, independent of whether electron/control exists)', () => {
  it('clean fixtures stay clean, so a rule cannot pass by rejecting everything', () => {
    expect(CLEAN.length).toBeGreaterThan(5);
    for (const r of CLEAN) expect({ id: r.id, v: fmt(analyzeControl(r.file, r.src)) }).toEqual({ id: r.id, v: [] });
  });

  it('every planted violation is rejected with its rule', () => {
    expect(BAD.length).toBeGreaterThan(60);
    for (const r of BAD) {
      const got = analyzeControl(r.file, r.src).violations.filter((x) => x.rule === r.rule && x.msg.includes(r.has));
      expect({ id: r.id, rejected: got.length > 0 }).toEqual({ id: r.id, rejected: true });
    }
  });

  it('every rule is tripped by at least one planted fixture', () => {
    const tripped = new Set<Rule>(BAD.map((r) => r.rule));
    tripped.add('file'); // exercised by the scratch-directory test below
    expect(ALL_RULES.filter((r) => !tripped.has(r))).toEqual([]);
  });

  it('the input sink is counted, so a router that stops writing is noticed', () => {
    const ok = CLEAN.find((r) => r.id === 'router-binding');
    expect(analyzeControl('inputRouter.ts', ok?.src ?? '').facts.sinks).toBe(1);
  });

  it('message-set equality (rule 3) holds for the fixtures', () => {
    for (const c of CROSS) {
      const m = new Map<string, Analysis>(Object.entries(c.files).map(([n, s]) => [n, analyzeControl(n, s)]));
      const own = [...m.values()].flatMap(fmt);
      const cross = crossCheck(m).map((x) => `[${x.rule}] ${x.msg}`);
      expect({ id: c.id, own }).toEqual({ id: c.id, own: [] });
      if (c.expectViolation) expect({ id: c.id, hit: cross.some((x) => x.includes(c.has ?? '')) }).toEqual({ id: c.id, hit: true });
      else expect({ id: c.id, cross }).toEqual({ id: c.id, cross: [] });
    }
  });
});

describe('phone control: directory-level rules on a scratch copy', () => {
  function withDir(files: Record<string, string>, fn: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-guard-'));
    try {
      for (const [n, s] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), s);
      fn(dir);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const good = Object.fromEntries(
    ['protocol', 'controlGateway', 'inputRouter', 'controlHub', 'controlIpc'].map((f) => [`${f}.ts`, CLEAN.find((r) => r.file === `${f}.ts`)?.src ?? '']),
  );
  // The clean gateway handles hello and attach; make protocol declare the same two.
  good['protocol.ts'] = "export const MESSAGE_TYPES = { phoneToTitan: ['hello', 'attach'] } as const;\nexport function validateInput(x: unknown): string { return String(x); }";

  it('missing and empty directories are explicit clean states', () => {
    expect(scanControlDir(path.join(os.tmpdir(), 'control-guard-does-not-exist'))).toEqual({ exists: false, files: [], violations: [] });
    withDir({}, (d) => expect(scanControlDir(d)).toEqual({ exists: true, files: [], violations: [] }));
  });

  it('a complete clean directory passes', () => {
    withDir(good, (d) => expect(scanControlDir(d).violations).toEqual([]));
  });

  it('a planted violation in each file is caught', () => {
    for (const [file, plant] of [
      ['controlGateway.ts', "\nimport { spawn } from 'child_process';\nvoid spawn;"],
      ['inputRouter.ts', "\nexport const bad = (terminals: { write(s: number, d: string): void }, raw: string): void => { terminals.write(0, raw); };"],
      ['controlHub.ts', "\nimport fs from 'fs';\nvoid fs;"],
      ['controlIpc.ts', "\nexport const e = (s: string) => eval(s);"],
    ] as const) {
      withDir({ ...good, [file]: good[file] + plant }, (d) => {
        const r = scanControlDir(d);
        expect({ file, red: r.violations.some((x) => x.startsWith(file)) }).toEqual({ file, red: true });
      });
    }
  });

  it('a new verb in the gateway turns the directory red', () => {
    withDir({ ...good, 'controlGateway.ts': good['controlGateway.ts'].replace("case 'attach'", "case 'kill'") }, (d) => {
      expect(scanControlDir(d).violations.join('\n')).toContain('undeclared: [kill]');
    });
  });

  it('an unlisted file, an odd extension, a subdirectory or a reserved name is a violation', () => {
    withDir({ ...good, 'extra.ts': 'export {};' }, (d) => expect(scanControlDir(d).violations.join('\n')).toContain('extra.ts: [file] not on the file allow-list'));
    withDir({ ...good, 'controlHub.mjs': 'export {};' }, (d) => expect(scanControlDir(d).violations.join('\n')).toContain('controlHub.mjs: [file]'));
    withDir({ ...good, 'EVIL.TS': 'export {};' }, (d) => expect(scanControlDir(d).violations.join('\n')).toContain('EVIL.TS: [file]'));
    withDir(good, (d) => {
      fs.mkdirSync(path.join(d, 'sub'));
      fs.mkdirSync(path.join(d, 'node_modules'));
      const v = scanControlDir(d).violations.join('\n');
      expect(v).toContain('sub/: [file] subdirectory');
      expect(v).toContain('node_modules: [file] reserved directory name');
    });
  });

  it('a symlink is a violation where the platform allows creating one', () => {
    withDir(good, (d) => {
      try { fs.symlinkSync(path.join(d, 'protocol.ts'), path.join(d, 'controlIpc2.ts')); } catch { return; /* no symlink privilege on this machine */ }
      expect(scanControlDir(d).violations.join('\n')).toContain('controlIpc2.ts: [file] symlink');
    });
  });
});
