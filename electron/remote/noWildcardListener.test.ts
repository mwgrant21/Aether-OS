// @vitest-environment node
// electron/remote/noWildcardListener.test.ts
//
// Source-scan guard for the remote read-only chat view (docs/privacy-and-data.md §16).
// It fails if the tree gains a wildcard bind, a second listener in electron/remote, a pty
// or electron value import there, a file write outside the session store, or a chat event
// built anywhere but chatParser.ts (the only place that masks before constructing).
//
// Scaffolding (ROOTS / SKIP_DIR_NAMES / walk) is modelled on src/shared/noApiCalls.test.ts.
// Paths resolve from this file, not the cwd, so a wrong cwd cannot make the scan vacuous.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import corpus from './noWildcardListener.corpus.json';

const REPO = path.resolve(__dirname, '../..');
const ROOTS = ['electron', 'scripts'];
const SKIP_DIR_NAMES = new Set(['node_modules', '.worktrees', 'dist', 'dist-electron', 'release']);
const SOURCE_EXTENSIONS = ['.ts', '.mjs', '.js'];

function isTestOrDecl(name: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|mjs)$/.test(name) || name.endsWith('.d.ts') || name.endsWith('.d.mts');
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && SOURCE_EXTENSIONS.some((e) => entry.name.endsWith(e)) && !isTestOrDecl(entry.name)) {
      out.push(full);
    }
  }
}

function posixRel(file: string): string {
  return path.relative(REPO, file).replace(/\\/g, '/');
}

const allFiles: string[] = [];
for (const r of ROOTS) {
  const dir = path.join(REPO, r);
  if (fs.existsSync(dir)) walk(dir, allFiles);
}
const read = (f: string): string => fs.readFileSync(f, 'utf8');

// Every non-test .ts/.mjs/.js at any depth under electron/remote, so a subdirectory cannot hide a rule break.
const remoteFiles = allFiles.filter((f) => /^electron\/remote\/.+\.(?:ts|mjs|js)$/.test(posixRel(f)));
const remoteSet = new Set(remoteFiles);
const nameOf = (f: string): string => posixRel(f).slice('electron/remote/'.length);
const remoteByName = new Map(remoteFiles.map((f) => [nameOf(f), f]));

/** Module specifiers of import/export-from/require/dynamic import, with a type-only flag. */
function importsOf(text: string): { spec: string; typeOnly: boolean }[] {
  const out: { spec: string; typeOnly: boolean }[] = [];
  for (const m of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
    out.push({ spec: m[2], typeOnly: !!m[1] });
  }
  for (const m of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push({ spec: m[1], typeOnly: false });
  for (const m of text.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push({ spec: m[1], typeOnly: false });
  }
  return out;
}

const FS_SPEC = /^(?:node:)?fs(?:\/promises)?$/;

// The only .listen( calls that exist outside electron/remote. Matched by exact call-site text.
// Keyed by file; the value is the call text after the receiver (a chained or newline-split receiver cannot dodge it).
const LISTEN_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ['electron/permissionServer.ts', "listen(options.port, '127.0.0.1')"],
  ['electron/communicationBridge/pipeServer.ts', 'listen(endpoint,'],
  // RISKS in the mobile remote-access plan: isPortAvailable() binds all interfaces for an instant
  // (permission-server port probe). Pre-existing; the one-line fix (probe.listen(port, '127.0.0.1'))
  // is its own ticket, so main.ts is allow-listed here rather than changed.
  ['electron/main.ts', 'listen(port)'],
]);

describe('remote access: no wildcard listener', () => {
  it('scan scope is real (no vacuous pass from a wrong cwd)', () => {
    expect(allFiles.length).toBeGreaterThan(0);
    expect(remoteFiles.length).toBeGreaterThan(0);
    for (const name of ['remoteServer.ts', 'chatFeed.ts', 'sessionStore.ts']) {
      expect(remoteByName.has(name), 'missing from scan: ' + name).toBe(true);
    }
  });

  it('no non-test source under electron/ or scripts/ contains a wildcard bind literal', () => {
    const offenders = allFiles
      .filter((f) => /(['"`])(?:0\.0\.0\.0|::)\1/.test(read(f)))
      .map(posixRel);
    expect(offenders).toEqual([]);
  });

  it('electron/remote has exactly one listen(), in remoteServer.ts, with an explicit host, after assertBindableHost', () => {
    const calls: { file: string; text: string; at: number }[] = [];
    for (const f of remoteFiles) {
      const text = read(f);
      for (const m of text.matchAll(/\.listen\s*\(/g)) {
        calls.push({ file: nameOf(f), text: text.slice(m.index!), at: m.index! });
      }
    }
    expect(calls.map((c) => c.file)).toEqual(['remoteServer.ts']);
    const call = calls[0];
    // listen(port, host, ...): at least two arguments before any closing paren.
    expect(call.text, 'listen() must pass an explicit host').toMatch(/^\.listen\s*\(\s*[^,()]+,\s*[^,()\s][^,()]*[,)]/);
    // ...and that host is the one assertBindableHost checked.
    expect(call.text, 'listen() must bind opts.host').toMatch(/^\.listen\s*\(\s*opts\.port\s*,\s*opts\.host\b/);
    const src = read(remoteByName.get('remoteServer.ts')!);
    const guardAt = src.search(/\bassertBindableHost\s*\(/);
    expect(guardAt, 'assertBindableHost is not called').toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(call.at);
  });

  it("only remoteServer.ts imports 'ws' under electron/remote", () => {
    const importers = remoteFiles
      .filter((f) => importsOf(read(f)).some((i) => i.spec === 'ws'))
      .map(nameOf);
    expect(importers).toEqual(['remoteServer.ts']);
    // No renamed import: an alias (import { WebSocketServer as WSS }) would dodge the ...Server( matcher below.
    const clause = read(remoteByName.get('remoteServer.ts')!).match(/import\s+[^;]*?from\s+['"]ws['"]/);
    expect(clause, "remoteServer.ts must import 'ws'").not.toBeNull();
    expect(clause![0], "no aliased import from 'ws'").not.toMatch(/\bas\b/);
  });

  // Matches new WebSocketServer(, new WS.Server(, new WS.WebSocketServer(, new Server(, and any alias
  // ending in Server, so the legacy and aliased constructors cannot dodge the noServer rule.
  it('every ...Server( construction in remoteServer.ts is noServer: true', () => {
    const text = read(remoteByName.get('remoteServer.ts')!);
    let seen = 0;
    for (const m of text.matchAll(/\bnew\s+[\w$.]*Server\s*\(([\s\S]*?)\)/g)) {
      seen++;
      expect(m[1], 'a ws server must be noServer: ' + m[0].slice(0, 40)).toMatch(/noServer\s*:\s*true/);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('every listen() elsewhere under electron/ and scripts/ is on the reviewed allow-list, and no entry is stale', () => {
    const offenders: string[] = [];
    const used = new Set<string>();
    for (const f of allFiles) {
      const rel = posixRel(f);
      if (remoteSet.has(f)) continue;
      const text = read(f);
      for (const m of text.matchAll(/\.listen\s*\(/g)) {
        const allowed = LISTEN_ALLOWLIST.get(rel);
        if (allowed && text.slice(m.index! + 1).startsWith(allowed)) used.add(rel);
        else offenders.push(rel + ': ' + text.slice(m.index!, m.index! + 60).split('\n')[0]);
      }
    }
    expect(offenders).toEqual([]);
    expect([...used].sort()).toEqual([...LISTEN_ALLOWLIST.keys()].sort());
  });
});

describe('remote access: read-only, no pty', () => {
  it('electron/remote sources import no pty module and no electron value', () => {
    const offenders: string[] = [];
    for (const f of remoteFiles) {
      for (const i of importsOf(read(f))) {
        if (/ptyLifecycle|ptyManager|codexPtyManager|node-pty/.test(i.spec)) offenders.push(`${nameOf(f)}: ${i.spec}`);
        // A type-only import is erased at build time; remoteIpc.ts imports IpcMain types this way.
        if (i.spec === 'electron' && !i.typeOnly) offenders.push(`${nameOf(f)}: value import of electron`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('electron/remote never writes to a pty, kills a process, or .write()s anything but a response/socket', () => {
    const offenders: string[] = [];
    const ALLOWED_RECEIVER = /^(?:res|socket|ws|client)$/;
    for (const f of remoteFiles) {
      const text = read(f);
      const name = nameOf(f);
      if (/pty:write/.test(text)) offenders.push(name + ': pty:write');
      if (/\.kill\s*\(/.test(text)) offenders.push(name + ': .kill(');
      for (const m of text.matchAll(/([\w$]+)\s*\.write\s*\(/g)) {
        if (!ALLOWED_RECEIVER.test(m[1])) offenders.push(`${name}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('remote access: nothing persisted but the session store', () => {
  it('node:fs is imported only by chatFeed.ts and sessionStore.ts', () => {
    const importers = remoteFiles
      .filter((f) => importsOf(read(f)).some((i) => FS_SPEC.test(i.spec)))
      .map((f) => nameOf(f))
      .sort();
    expect(importers).toEqual(['chatFeed.ts', 'sessionStore.ts']);
  });

  // Allow-list, not deny-list: copyFile, truncate, any write*Sync and every fs name not listed fails.
  it('chatFeed.ts uses only read-only fs names (promises.open and promises.stat)', () => {
    const text = read(remoteByName.get('chatFeed.ts')!);
    const imported = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/g)]
      .flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
    expect(imported).toEqual(['promises']);
    expect(text, 'default/namespace fs import').not.toMatch(/import\s+(?:\*\s+as\s+\w+|\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"](?:node:)?fs/);
    const used = new Set([...text.matchAll(/\bfsp\.(\w+)/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual(['open', 'stat']);
    expect(text).not.toMatch(/writeFile|appendFile|createWriteStream|rename|unlink|mkdir|\.rm\s*\(|\.truncate\s*\(|copyFile/);
  });

  it('sessionStore.ts writes only through writeFileAtomically', () => {
    const text = read(remoteByName.get('sessionStore.ts')!);
    expect(importsOf(text).some((i) => /atomicWrite/.test(i.spec)) && /\bwriteFileAtomically\b/.test(text)).toBe(true);
    expect(text).not.toMatch(/writeFileSync|appendFile|createWriteStream|\bwriteFile\b/);
  });

  it('no other electron/remote source imports atomicWrite or the collector/retention/memory/persistence stores', () => {
    const offenders: string[] = [];
    for (const f of remoteFiles) {
      const name = nameOf(f);
      for (const i of importsOf(read(f))) {
        if (/collectorStore|retentionStore|memoryStore|persistence/.test(i.spec)) offenders.push(`${name}: ${i.spec}`);
        if (/atomicWrite/.test(i.spec) && name !== 'sessionStore.ts') offenders.push(`${name}: ${i.spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("chat events (k: 'msg' / k: 'traffic') are constructed only in chatParser.ts (types.ts declares them)", () => {
    const offenders = remoteFiles
      .filter((f) => !['chatParser.ts', 'types.ts'].includes(nameOf(f)))
      .filter((f) => /\bk\s*:\s*['"](?:msg|traffic)['"]/.test(read(f)))
      .map((f) => nameOf(f));
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// AST engine. Parses with the TypeScript compiler API (syntax only: no Program, no TypeChecker).
// Tracking is name-based and scope-insensitive: a shadowing local with the same name is over-counted,
// which can only cause a false reject, and every escape of a tracked name is itself a violation.
// Comments and string contents are never visited as code.
// ---------------------------------------------------------------------------------------------
type Rule = 'syntax' | 'module' | 'fs' | 'ws' | 'listen' | 'wildcard' | 'pty' | 'write' | 'persist' | 'chat-event' | 'escape';
interface Violation { rule: Rule; msg: string }
interface RemoteFacts { fsRef: boolean; wsRef: boolean; listenCount: number; wsConstructions: number; atomicCalls: number }
interface RemoteAnalysis { violations: Violation[]; facts: RemoteFacts }
interface OutsideAnalysis { wildcard: string[]; listens: string[][] }

const FSP_READ: ReadonlySet<string> = new Set(['open', 'stat', 'lstat', 'readFile', 'readdir', 'readlink', 'realpath', 'access']);
const FS_SYNC_READ: ReadonlySet<string> = new Set(['readFileSync', 'statSync', 'lstatSync', 'readdirSync', 'readlinkSync', 'realpathSync', 'accessSync', 'existsSync']);
// Defence in depth: rejected anywhere in electron/remote as an identifier, member name or literal element access.
// If a legitimate identifier ever collides, rename it; never allow-list.
const WRITE_NAMES: ReadonlySet<string> = new Set([
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'rename', 'renameSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync',
  'truncate', 'truncateSync', 'ftruncate', 'ftruncateSync', 'symlink', 'symlinkSync', 'link', 'linkSync', 'chmod', 'chmodSync',
  'chown', 'chownSync', 'utimes', 'utimesSync', 'lutimes', 'writeSync', 'writev', 'writevSync',
]);
const DENY_IDENT: ReadonlySet<string> = new Set(['createRequire', 'eval', 'Function', 'globalThis', 'global', 'module']);
const DENY_PROP: ReadonlySet<string> = new Set(['createRequire', 'getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'mainModule', 'require', 'kill']);
const ELEMENT_ACCESS_BLOCKED_ON: ReadonlySet<string> = new Set(['process', 'globalThis', 'global', 'module', 'require']);
const WRITE_RECEIVERS: ReadonlySet<string> = new Set(['res', 'socket', 'ws', 'client']);
const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$/;
const PTY_MODULE = /ptyLifecycle|ptyManager|codexPtyManager|node-pty/;
const STORE_MODULE = /collectorStore|retentionStore|memoryStore|persistence/;
const WILDCARDS: ReadonlySet<string> = new Set(['0.0.0.0', '::']);

type StrLit = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;
function isStrLit(n: ts.Node | undefined): n is StrLit {
  return !!n && (n.kind === ts.SyntaxKind.StringLiteral || n.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral);
}

/** Text of an identifier or string-literal property key; null for anything else (computed, numeric, private). */
function keyText(name: ts.Node | undefined): string | null {
  return name && (ts.isIdentifier(name) || isStrLit(name)) ? name.text : null;
}

/** Name of a member access: `.x`, or `['x']` with a literal; null for a dynamic key. */
function memberName(n: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n) && isStrLit(n.argumentExpression)) return n.argumentExpression.text;
  return null;
}

/** An Identifier that can actually reference a binding (not a property key, member name or label). */
function isReference(n: ts.Identifier): boolean {
  const p = n.parent;
  if (!p) return true;
  if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
  if (ts.isQualifiedName(p) && p.right === n) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) ||
       ts.isPropertyDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p)) && p.name === n) return false;
  if (ts.isBindingElement(p) && p.propertyName === n) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return true;
}

function parseSource(name: string, text: string): { sf: ts.SourceFile; syntax: string[] } {
  const kind = /\.(?:mjs|js)$/.test(name) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = ts.transpileModule(text, {
    fileName: name,
    reportDiagnostics: true,
    compilerOptions: { allowJs: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, isolatedModules: true },
  }).diagnostics ?? [];
  return {
    sf,
    syntax: diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')),
  };
}

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (c) => visit(c, fn));
}

type ImportForm = 'named' | 'default-or-namespace' | 'side-effect' | 'export-from' | 'import-equals' | 'require' | 'dynamic-import' | 'import-type';
interface ModuleRef { spec: string | null; form: ImportForm; typeOnly: boolean; decl?: ts.ImportDeclaration }

/** Every module reference in the file, whatever the syntax. spec === null means the specifier is not a plain literal. */
function moduleRefs(sf: ts.SourceFile): ModuleRef[] {
  const refs: ModuleRef[] = [];
  visit(sf, (n) => {
    if (ts.isImportDeclaration(n)) {
      const c = n.importClause;
      const namedOnly = !!c && !c.name && !!c.namedBindings && ts.isNamedImports(c.namedBindings);
      const form: ImportForm = !c ? 'side-effect' : namedOnly ? 'named' : 'default-or-namespace';
      refs.push({ spec: isStrLit(n.moduleSpecifier) ? n.moduleSpecifier.text : null, form, typeOnly: !!c?.isTypeOnly, decl: n });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      refs.push({ spec: isStrLit(n.moduleSpecifier) ? n.moduleSpecifier.text : null, form: 'export-from', typeOnly: !!n.isTypeOnly });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const e = n.moduleReference.expression;
      refs.push({ spec: isStrLit(e) ? e.text : null, form: 'import-equals', typeOnly: !!n.isTypeOnly });
    } else if (ts.isCallExpression(n) && ((ts.isIdentifier(n.expression) && n.expression.text === 'require') || n.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      const a = n.arguments;
      const isImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      refs.push({ spec: a.length === 1 && isStrLit(a[0]) ? a[0].text : null, form: isImport ? 'dynamic-import' : 'require', typeOnly: false });
    } else if (ts.isImportTypeNode(n)) {
      const l = n.argument;
      refs.push({ spec: ts.isLiteralTypeNode(l) && isStrLit(l.literal) ? l.literal.text : null, form: 'import-type', typeOnly: true });
    }
  });
  return refs;
}

function objectHasKey(obj: ts.ObjectLiteralExpression, key: string): boolean {
  return obj.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) && keyText(p.name) === key);
}

/** Spread, computed key or accessor: the key set cannot be proven. */
function badObjectKey(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some((p) => ts.isSpreadAssignment(p) || (!!p.name && ts.isComputedPropertyName(p.name)) || ts.isGetAccessor(p) || ts.isSetAccessor(p));
}

/** Checks one allow-listed fs call; returns a message or null. `member` is the fs member name. */
function fsCallProblem(member: string, call: ts.CallExpression): string | null {
  const args = call.arguments;
  if (args.some((a) => ts.isSpreadElement(a))) return 'spread argument';
  if (member === 'open') {
    if (args.length !== 2) return "open must have exactly 2 args (path, 'r')";
    if (!(isStrLit(args[1]) && args[1].text === 'r')) return "open flag must be the literal 'r'";
  }
  if (member === 'readFile' || member === 'readFileSync') {
    if (args.length < 1 || args.length > 2) return 'readFile takes 1-2 args';
    const o = args[1];
    if (o && !isStrLit(o)) {
      if (!ts.isObjectLiteralExpression(o)) return 'readFile options must be a literal';
      if (badObjectKey(o)) return 'readFile options: spread/computed key';
      if (objectHasKey(o, 'flag')) return 'readFile options: flag property';
    }
  }
  return null;
}

type FsBinding = { kind: 'ns' } | { kind: 'member'; member: string };

/**
 * Per-file analysis of a file under electron/remote. `name` is the path under electron/remote with
 * forward slashes (`chatFeed.ts`, `sub/x.ts`); file-keyed rules compare the whole name, so
 * `sub/remoteServer.ts` is a foreign file (fail closed).
 */
function analyzeRemote(name: string, text: string): RemoteAnalysis {
  const found = new Map<string, Violation>();
  const v = (rule: Rule, msg: string): void => { found.set(`${rule}:${msg}`, { rule, msg }); };
  const { sf, syntax } = parseSource(name, text);
  for (const s of syntax) v('syntax', 'syntax error (cannot prove the file safe): ' + s);
  const refs = moduleRefs(sf);
  let fsRef = false;
  let wsRef = false;
  let wsConstructions = 0;
  let atomicCalls = 0;
  let assertPos: number | null = null;
  const listens: ts.CallExpression[] = [];

  // ---- module references ----
  const fsBindings = new Map<string, FsBinding>();
  let wsLocal: string | null = null;
  let atomicLocal: string | null = null;
  for (const r of refs) {
    if (r.spec === null) { v('module', `dynamic module specifier (${r.form})`); continue; }
    const norm = r.spec.replace(/^node:/, '');
    if (FS_MODULE.test(r.spec)) {
      fsRef = true;
      const clause = r.decl?.importClause;
      if (r.form !== 'named' || !clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
        v('fs', `fs module reached via ${r.form} (only named imports are tracked)`);
      } else {
        for (const el of clause.namedBindings.elements) {
          const imported = (el.propertyName ?? el.name).text;
          const local = el.name.text;
          if (clause.isTypeOnly || el.isTypeOnly) continue; // erased; no runtime binding
          if (norm === 'fs' && imported === 'promises') fsBindings.set(local, { kind: 'ns' });
          else if (norm === 'fs' && FS_SYNC_READ.has(imported)) fsBindings.set(local, { kind: 'member', member: imported });
          else if (norm === 'fs/promises' && FSP_READ.has(imported)) fsBindings.set(local, { kind: 'member', member: imported });
          else v('fs', `fs member not on the read-only allow-list: ${imported}`);
        }
      }
    }
    if (norm === 'ws') {
      wsRef = true;
      const clause = r.decl?.importClause;
      if (name !== 'remoteServer.ts') v('ws', "'ws' referenced outside remoteServer.ts");
      else if (r.form !== 'named' || !clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) v('ws', `'ws' must be a named import, found ${r.form}`);
      else {
        for (const el of clause.namedBindings.elements) {
          const imported = (el.propertyName ?? el.name).text;
          const typeOnly = clause.isTypeOnly || el.isTypeOnly;
          if (el.propertyName) v('ws', `aliased ws import: ${imported} as ${el.name.text}`);
          else if (imported === 'WebSocketServer' && !typeOnly) wsLocal = el.name.text;
          else if (imported === 'WebSocket' && typeOnly) { /* type only */ }
          else v('ws', `unexpected ws import: ${imported}${typeOnly ? ' (type)' : ''}`);
        }
      }
    }
    if (norm === 'child_process') v('pty', `child_process referenced (${r.form})`);
    if (PTY_MODULE.test(r.spec)) v('pty', `pty module referenced: ${r.spec}`);
    if (r.spec === 'electron' && !(r.form === 'named' && r.typeOnly)) v('pty', `value import of electron (${r.form})`);
    if (STORE_MODULE.test(r.spec)) v('persist', `forbidden store import: ${r.spec}`);
    if (/atomicWrite/.test(r.spec)) {
      if (name !== 'sessionStore.ts') v('persist', 'atomicWrite imported outside sessionStore.ts');
      else if (r.form === 'named' && !r.typeOnly) {
        const clause = r.decl?.importClause;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            if (!el.propertyName && el.name.text === 'writeFileAtomically' && !el.isTypeOnly) atomicLocal = 'writeFileAtomically';
          }
        }
      }
    }
  }
  if (fsRef && name !== 'chatFeed.ts' && name !== 'sessionStore.ts') v('fs', 'fs referenced outside chatFeed.ts and sessionStore.ts');
  if (name === 'remoteServer.ts' && !wsRef) v('ws', "remoteServer.ts must import 'ws'");
  if (name === 'remoteServer.ts' && refs.filter((r) => r.spec !== null && r.spec.replace(/^node:/, '') === 'ws').length > 1) v('ws', "exactly one 'ws' reference allowed");

  // ---- node walk: references, calls, tokens ----
  visit(sf, (n) => {
    if (ts.isIdentifier(n)) {
      const t = n.text;
      const p = n.parent;
      if (WRITE_NAMES.has(t)) v('fs', `write-capable name: ${t}`);
      const ref = isReference(n);
      const declSite = ts.isImportSpecifier(p);
      if (ref && DENY_IDENT.has(t) && !declSite) v('escape', `escape-hatch identifier: ${t}`);
      if (t === 'require' && ref) {
        if (!(ts.isCallExpression(p) && p.expression === n && p.arguments.length === 1)) v('escape', 'require used other than require("literal")');
      }
      const binding = fsBindings.get(t);
      if (ref && !declSite && binding) {
        if (binding.kind === 'member') {
          if (ts.isCallExpression(p) && p.expression === n && !p.questionDotToken) {
            const m = fsCallProblem(binding.member, p);
            if (m) v('fs', `${t}(): ${m}`);
          } else v('fs', `fs binding ${t} used other than as a direct call`);
        } else {
          const g = p.parent;
          if (ts.isPropertyAccessExpression(p) && p.expression === n && !p.questionDotToken && ts.isCallExpression(g) && g.expression === p && !g.questionDotToken && FSP_READ.has(p.name.text)) {
            const m = fsCallProblem(p.name.text, g);
            if (m) v('fs', `${t}.${p.name.text}(): ${m}`);
          } else v('fs', `fs binding ${t} used other than as a direct read-only call`);
        }
      }
      if (ref && wsLocal !== null && t === wsLocal && !declSite) {
        const ok = (ts.isNewExpression(p) && p.expression === n) || (ts.isTypeReferenceNode(p) && p.typeName === n);
        if (!ok) v('ws', 'WebSocketServer used other than as new WebSocketServer(...)');
      }
      if (atomicLocal !== null && t === atomicLocal && ref && !declSite) {
        if (ts.isCallExpression(p) && p.expression === n) atomicCalls++;
        else v('persist', 'writeFileAtomically used other than as a direct call');
      }
    }
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && ELEMENT_ACCESS_BLOCKED_ON.has(n.expression.text)) v('escape', `element access on ${n.expression.text}`);
      const m = memberName(n);
      if (m !== null) {
        if (DENY_PROP.has(m)) v('escape', `denied member: .${m}`);
        if (WRITE_NAMES.has(m) && ts.isElementAccessExpression(n)) v('fs', `write-capable name (element access): ${m}`);
        if (m === 'write') {
          const r = n.expression;
          const rname = ts.isIdentifier(r) ? r.text : ts.isPropertyAccessExpression(r) ? r.name.text : null;
          if (!(rname && WRITE_RECEIVERS.has(rname))) v('write', '.write on a receiver other than res/socket/ws/client');
        }
      }
    }
    if ((isStrLit(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && /pty:write/.test(n.text)) v('write', 'pty:write string');
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && memberName(callee) === 'listen') listens.push(n);
      if (ts.isIdentifier(callee) && callee.text === 'assertBindableHost') assertPos = Math.min(assertPos ?? Infinity, n.getStart(sf));
    }
    if (ts.isNewExpression(n)) {
      const c = n.expression;
      const cname = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : null;
      if (cname !== null && /Server$/.test(cname)) {
        if (ts.isIdentifier(c) && wsLocal !== null && c.text === wsLocal) {
          wsConstructions++;
          const a = n.arguments ?? [];
          const o = a[0];
          if (a.length !== 1 || !o || !ts.isObjectLiteralExpression(o)) v('ws', 'WebSocketServer(...) needs one object-literal argument');
          else {
            if (badObjectKey(o)) v('ws', 'WebSocketServer options: spread/computed key');
            const ns = o.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && keyText(p.name) === 'noServer');
            if (!ns || ns.initializer.kind !== ts.SyntaxKind.TrueKeyword) v('ws', 'WebSocketServer must set noServer: true as a direct property');
            for (const bad of ['port', 'server', 'host']) if (objectHasKey(o, bad)) v('ws', `WebSocketServer options must not set ${bad}`);
          }
        } else v('ws', `server construction other than the ws noServer one: new ${cname}`);
      }
    }
    // chat events
    if (name !== 'chatParser.ts' && name !== 'types.ts') {
      if (ts.isPropertyAssignment(n) && keyText(n.name) === 'k' && isStrLit(n.initializer) && /^(?:msg|traffic)$/.test(n.initializer.text)) v('chat-event', 'chat event constructed outside chatParser.ts');
      if (ts.isPropertySignature(n) && keyText(n.name) === 'k' && n.type && ts.isLiteralTypeNode(n.type) && isStrLit(n.type.literal) && /^(?:msg|traffic)$/.test(n.type.literal.text)) v('chat-event', 'chat event declared outside types.ts');
    }
    if (isStrLit(n) && WILDCARDS.has(n.text)) v('wildcard', `wildcard bind literal: ${n.text}`);
  });

  if (name === 'sessionStore.ts' && (atomicLocal === null || atomicCalls === 0)) v('persist', 'sessionStore.ts must write through a direct writeFileAtomically() call');
  if (listens.length && name !== 'remoteServer.ts') v('listen', 'listen() in electron/remote outside remoteServer.ts');
  if (name === 'remoteServer.ts') {
    const isAccess = (e: ts.Expression | undefined, obj: string, prop: string): boolean =>
      !!e && ts.isPropertyAccessExpression(e) && !e.questionDotToken && ts.isIdentifier(e.expression) && e.expression.text === obj && e.name.text === prop;
    for (const call of listens) {
      const a = call.arguments;
      if (!(a.length >= 2 && isAccess(a[0], 'opts', 'port') && isAccess(a[1], 'opts', 'host'))) v('listen', 'listen() must be listen(opts.port, opts.host, ...)');
      if (assertPos === null || assertPos > call.getStart(sf)) v('listen', 'assertBindableHost() must be called before listen()');
    }
    if (wsConstructions !== 1) v('ws', `expected exactly one WebSocketServer construction, found ${wsConstructions}`);
  }
  return { violations: [...found.values()], facts: { fsRef, wsRef, listenCount: listens.length, wsConstructions, atomicCalls } };
}

/** For a file under electron/ or scripts/ that is NOT in electron/remote: wildcard literals plus each listen() call's argument texts. */
function analyzeOutside(relPath: string, text: string): OutsideAnalysis {
  const { sf } = parseSource(relPath, text);
  const wildcard: string[] = [];
  const listens: string[][] = [];
  visit(sf, (n) => {
    if (isStrLit(n) && WILDCARDS.has(n.text)) wildcard.push(n.text);
    if (ts.isCallExpression(n) && (ts.isPropertyAccessExpression(n.expression) || ts.isElementAccessExpression(n.expression)) && memberName(n.expression) === 'listen') {
      listens.push(n.arguments.map((a) => a.getText(sf).replace(/\s+/g, ' ')));
    }
  });
  return { wildcard, listens };
}

// ---------------------------------------------------------------------------------------------
// Corpus: the fixture contract for the engine. Rows live in noWildcardListener.corpus.json.
// `old` is what be0b260's regex guard did with the row; `want` is what this engine must do.
// ---------------------------------------------------------------------------------------------
type Verdict = 'PASS' | 'REJ';
type Relaxation = 'comment' | 'string' | 'syntax' | 'tolerance';
type MutateOp = { replace: [string, string] } | { append: string };
interface CorpusRow {
  id: string;
  src: string;
  file: string;
  label: string;
  text?: string;
  mutate?: { base: string; ops: MutateOp[] };
  want: Verdict;
  old: Verdict;
  relaxation?: Relaxation;
}
const CORPUS = corpus as unknown as CorpusRow[];
const RELAXATION_TAGS: ReadonlySet<string> = new Set(['comment', 'string', 'syntax', 'tolerance']);

/** Source text of a corpus row; a `mutate` row edits the REAL file in memory, and a stale anchor fails loudly. */
function loadRow(row: CorpusRow): string {
  if (!row.mutate) return row.text ?? '';
  const base = remoteByName.get(row.mutate.base);
  if (!base) throw new Error(`${row.id}: base file electron/remote/${row.mutate.base} is gone; update the row`);
  let t = read(base);
  for (const op of row.mutate.ops) {
    if ('replace' in op) {
      if (!t.includes(op.replace[0])) throw new Error(`${row.id}: anchor missing in ${row.mutate.base}: ${JSON.stringify(op.replace[0])}; update the corpus row`);
      t = t.replace(op.replace[0], () => op.replace[1]);
    } else t += op.append;
  }
  return t;
}

const verdictOf = (row: CorpusRow): Verdict => (analyzeRemote(row.file, loadRow(row)).violations.length ? 'REJ' : 'PASS');

describe('remote access guard: AST engine', () => {
  it('corpus: engine verdict equals the recorded want for every row', () => {
    const mismatches = CORPUS.filter((r) => verdictOf(r) !== r.want).map((r) => `${r.id}: ${r.label}`);
    expect(mismatches).toEqual([]);
  });

  // A corpus claim, not a proof over all inputs: every row be0b260 rejected is still rejected, except the rows
  // tagged `relaxation`, each an intended loosening (comment/string content is invisible by design; an inline
  // `type` specifier and an import split by a block comment were false rejects of the regex; read-only fs names
  // beyond {open, stat} and named fs imports are the tolerance that was asked for).
  it('corpus: every row be0b260 rejected is still rejected unless tagged as an intended relaxation', () => {
    const broken = CORPUS.filter((r) => r.old === 'REJ' && !r.relaxation && verdictOf(r) !== 'REJ').map((r) => `${r.id}: ${r.label}`);
    expect(broken).toEqual([]);
  });

  it('corpus integrity: unique ids, valid verdicts and tags, required rows, every mutate anchor present', () => {
    const ids = CORPUS.map((r) => r.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(CORPUS.filter((r) => !['PASS', 'REJ'].includes(r.want) || !['PASS', 'REJ'].includes(r.old)).map((r) => r.id)).toEqual([]);
    expect(CORPUS.filter((r) => r.relaxation !== undefined && !RELAXATION_TAGS.has(r.relaxation)).map((r) => r.id)).toEqual([]);
    expect(CORPUS.filter((r) => r.relaxation !== undefined && r.old !== 'REJ').map((r) => r.id)).toEqual([]);
    expect(CORPUS.length).toBeGreaterThanOrEqual(200);
    expect(ids.filter((id) => id.startsWith('T3-fs-'))).toHaveLength(40);
    expect(ids.filter((id) => id.startsWith('T3-ws-'))).toHaveLength(21);
    // The three round-2 MUST-FIX shapes on the real chatFeed.ts (comment-hosted decoy; `;` hidden in a line and a block comment).
    for (const needle of ['comment-hosted fake fsp import', 'import { symlinkSync, // ;', 'import { chmodSync /* ; */ }']) {
      expect(CORPUS.some((r) => r.label.includes(needle)), 'missing round-2 row: ' + needle).toBe(true);
    }
    expect(() => CORPUS.forEach(loadRow)).not.toThrow();
  });

  it('real tree: every electron/remote file is clean under the engine', () => {
    const names = [...remoteByName.keys()];
    for (const required of ['chatFeed.ts', 'sessionStore.ts', 'remoteServer.ts']) expect(names, 'missing from scan: ' + required).toContain(required);
    const offenders: string[] = [];
    for (const [name, file] of remoteByName) {
      for (const x of analyzeRemote(name, read(file)).violations) offenders.push(`${name}: [${x.rule}] ${x.msg}`);
    }
    expect(offenders).toEqual([]);
  });
});
