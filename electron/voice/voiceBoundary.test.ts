// @vitest-environment node
// electron/voice/voiceBoundary.test.ts
//
// AST guard for the voice gateway: electron/voice/ has one listener, one child launch, no disk
// writes, no pty, no wildcard bind and a closed phone-to-PC message set. Discovery-based: every
// non-test file under electron/voice/ with one of the eight extensions .ts .mts .cts .tsx .js .mjs .cjs
// .jsx (matched case-insensitively; fixtures included) is parsed with the TypeScript
// compiler API (syntax only), so a new file is fenced the moment it exists. Name-based and
// scope-insensitive: a drift-and-mistakes guard, not a sandbox (transitive imports are out of reach).
// Paths resolve from this file, not the cwd. Files named *.test.* / *.spec.* and *.d.ts are exempt from
// scanning by design, so a production-looking module must never be given such a name.
//
// What a name-based guard cannot catch (explicit, not silent): bracket calls such as server['listen'](0)
// or l.call(server, 0) on an aliased method, computed strings such as '0.0.0.' + '0', assertBindableHost
// sitting under if (false) (it only has to appear earlier in the file), a second spawn reached through an
// object the guard does not name, and anything transitive through an imported module. Also out of reach:
// require('ws').Server and a re-export of WebSocketServer under a new name (rule 2 matches constructor
// text and import bindings only), dgram.bind and Bun.listen/Bun.serve (rule 1 sees .listen( only),
// spawn aliases such as `const sp = spawn` and promisify(execFile) (noApiCalls.test.ts covers literal
// 'claude' launches repo-wide), process aliases that survive rule 6 (a destructure such as
// `const { process: p } = globalThis`, or a process value reached through a call result), and fs write
// names reached through an alias of an alias beyond plain `const x = fsNamespace` chains. It guards
// against drift and mistakes, not against a determined author.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

const VOICE_DIR = path.resolve(__dirname);
const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];
const REQUIRED = ['voiceServer.ts', 'voiceSession.ts', 'voiceGateway.ts', 'speechFilter.ts'];
const WRITE_NAMES = new Set([
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'writeSync',
  'rename', 'renameSync', 'unlink', 'unlinkSync', 'mkdir', 'mkdirSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
  'copyFile', 'copyFileSync', 'cp', 'cpSync', 'truncate', 'truncateSync', 'ftruncate', 'ftruncateSync',
  'symlink', 'symlinkSync', 'link', 'linkSync', 'mkdtemp', 'mkdtempSync', 'utimes', 'utimesSync',
  'chmod', 'chmodSync', 'chown', 'chownSync',
]);
// Modules that may never be imported under electron/voice (extra processes or threads).
const BANNED_MODULES = new Set(['execa', 'cross-spawn', 'worker_threads', 'node:worker_threads', 'cluster', 'node:cluster']);
const FORBIDDEN_FLAGS = ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--mcp-config', '--add-dir', 'bypassPermissions', 'acceptEdits'];

// pty modules by name: node-pty, ptyManager/pty-host/codexPty style names, terminalHub, and the stores/persistence.
// Segment based, so 'emptyState' (contains the letters "pty") does not trip it.
function isBannedModule(spec: string): boolean {
  const segs = spec.split('/');
  const last = segs[segs.length - 1].replace(/\.[cm]?[tj]sx?$/, '');
  const pty = (s: string): boolean => s === 'node-pty' || /(^|[-_.])pty([-_.]|$)/i.test(s) || /^pty[A-Z]/.test(s) || /[a-z]Pty($|[A-Z])/.test(s);
  return segs.some(pty) || /^(terminalHub|codexPty|collectorStore|retentionStore|memoryStore|persistence)$/i.test(last);
}
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const CLIENT_T = ['permission.reply', 'resume', 'turn.cancel', 'turn.start'];

function isTestOrDecl(name: string): boolean {
  return /\.(test|spec)\.[cm]?[tj]sx?$/i.test(name) || /\.d\.[cm]?ts$/i.test(name);
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()) && !isTestOrDecl(entry.name)) out.push(full);
  }
}

interface Scanned {
  rel: string; // posix path relative to electron/voice
  base: string;
  fixture: boolean;
  sf: ts.SourceFile;
}

const files: string[] = [];
walk(VOICE_DIR, files);
const scanned: Scanned[] = files.map((full) => {
  const rel = path.relative(VOICE_DIR, full).split(path.sep).join('/');
  const ext = path.extname(full).toLowerCase();
  const kind = ext === '.tsx' ? ts.ScriptKind.TSX : ext === '.jsx' ? ts.ScriptKind.JSX : /^\.[cm]?ts$/.test(ext) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, kind);
  return { rel, base: path.basename(full), fixture: rel.startsWith('__fixtures__/'), sf };
});

function find<T extends ts.Node>(sf: ts.SourceFile, pred: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const visit = (n: ts.Node): void => {
    if (pred(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const isCall = (n: ts.Node): n is ts.CallExpression => ts.isCallExpression(n);
const isObj = (n: ts.Node): n is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(n);

function calleeName(c: ts.CallExpression): string {
  const e = c.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return '';
}

function propName(p: ts.ObjectLiteralElementLike): string {
  const n = p.name;
  return n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : '';
}

function prop(o: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return o.properties.find((p) => propName(p) === name);
}

const initText = (p: ts.ObjectLiteralElementLike | undefined): string | undefined =>
  p && ts.isPropertyAssignment(p) ? p.initializer.getText() : undefined;

interface Imp { spec: string; typeOnly: boolean; names: string[]; defaultOrNs: boolean; bindings: { imported: string; local: string }[] }

function importsOf(sf: ts.SourceFile): Imp[] {
  const out: Imp[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const c = st.importClause;
      const nb = c?.namedBindings;
      out.push({
        spec: st.moduleSpecifier.text,
        typeOnly: !!c?.isTypeOnly,
        names: nb && ts.isNamedImports(nb) ? nb.elements.map((e) => (e.propertyName ?? e.name).text) : [],
        defaultOrNs: !!c && (!!c.name || (!!nb && ts.isNamespaceImport(nb))),
        bindings: nb && ts.isNamedImports(nb) ? nb.elements.filter((e) => !e.isTypeOnly).map((e) => ({ imported: (e.propertyName ?? e.name).text, local: e.name.text })) : [],
      });
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      out.push({ spec: st.moduleSpecifier.text, typeOnly: st.isTypeOnly, names: [], defaultOrNs: false, bindings: [] });
    }
  }
  // dynamic import() and require() with a literal specifier
  for (const c of find(sf, isCall)) {
    const a = c.arguments[0];
    const dyn = c.expression.kind === ts.SyntaxKind.ImportKeyword;
    if ((dyn || calleeName(c) === 'require') && a && ts.isStringLiteralLike(a)) {
      out.push({ spec: a.text, typeOnly: false, names: [], defaultOrNs: true, bindings: [] });
    }
  }
  return out;
}

const here = (s: Scanned, n: ts.Node): string =>
  `${s.rel}:${s.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
const byName = (n: string): Scanned => {
  const s = scanned.find((x) => x.rel === n);
  if (!s) throw new Error(`${n} missing from scan`);
  return s;
};
const prod = (): Scanned[] => scanned.filter((s) => !s.fixture);

// process.env, process['env'], and process[<non-literal>] (any computed access to process).
function isProcessEnv(n: ts.Node): boolean {
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  if (ts.isPropertyAccessExpression(n)) return n.expression.getText() === 'process' && n.name.text === 'env';
  if (ts.isElementAccessExpression(n)) return n.expression.getText() === 'process' && (!ts.isStringLiteralLike(n.argumentExpression) || n.argumentExpression.text === 'env');
  return false;
}

const parseSnippet = (text: string): ts.SourceFile => ts.createSourceFile('snippet.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

// Every string piece (plain, no-substitution template, template head/middle/tail) in a file.
function stringPieces(sf: ts.SourceFile): { n: ts.Node; text: string }[] {
  const out: { n: ts.Node; text: string }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push({ n, text: n.text });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const GLOBAL_ROOTS = new Set(['globalThis', 'global', 'self', 'window']);

// `process` used as a value other than as the object of .x / ['x']: const p = process, f(process),
// globalThis.process, globalThis['process'] / globalThis[expr]. A local function named process (declared
// name or call callee), property names, import specifiers and type positions are not aliases.
function processAliases(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  for (const n of find(sf, ts.isIdentifier)) {
    if (n.text !== 'process') continue;
    const p = n.parent;
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === n) continue;
    if (ts.isPropertyAccessExpression(p)) {
      if (GLOBAL_ROOTS.has(p.expression.getText())) out.push(n);
      continue;
    }
    if (ts.isCallExpression(p) && p.expression === n) continue;
    if ((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isPropertyAssignment(p) || ts.isPropertySignature(p)
      || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isBindingElement(p)) && p.name === n) continue;
    if (ts.isImportSpecifier(p) || ts.isTypeQueryNode(p) || ts.isQualifiedName(p) || ts.isExportSpecifier(p)) continue;
    out.push(n);
  }
  for (const e of find(sf, ts.isElementAccessExpression)) {
    const a = e.argumentExpression;
    if (GLOBAL_ROOTS.has(e.expression.getText()) && (!ts.isStringLiteralLike(a) || a.text === 'process')) out.push(e);
  }
  return out;
}

// Calls to fs write names, only where the callee is bound to fs: a named import / destructure of a write
// name from fs, or a member of an fs namespace (import * / default / require / createRequire(...)('fs')).
function fsWriteCalls(sf: ts.SourceFile): ts.CallExpression[] {
  const ns = new Set<string>();
  const fnLocals = new Set<string>();
  const isFsLit = (e: ts.Expression | undefined): boolean => !!e && ts.isStringLiteralLike(e) && FS_MODULES.has(e.text);
  const unwrap = (e: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e)) e = e.expression;
    return e;
  };
  const fsSource = (init: ts.Expression | undefined): boolean => {
    if (!init) return false;
    const e = unwrap(init);
    if (ts.isIdentifier(e)) return ns.has(e.text);
    if (!ts.isCallExpression(e)) return false;
    const isLoad = (c: ts.CallExpression): boolean => c.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(c.expression) && c.expression.text === 'require');
    return (isLoad(e) || ts.isCallExpression(e.expression)) && isFsLit(e.arguments[0]);
  };
  for (const imp of importsOf(sf).filter((i) => FS_MODULES.has(i.spec))) {
    for (const b of imp.bindings) if (WRITE_NAMES.has(b.imported)) fnLocals.add(b.local);
  }
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !FS_MODULES.has(st.moduleSpecifier.text)) continue;
    const c = st.importClause;
    if (c?.name) ns.add(c.name.text);
    if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) ns.add(c.namedBindings.name.text);
  }
  for (const n of find(sf, ts.isImportEqualsDeclaration)) {
    if (ts.isExternalModuleReference(n.moduleReference) && isFsLit(n.moduleReference.expression)) ns.add(n.name.text);
  }
  for (const d of find(sf, ts.isVariableDeclaration)) {
    if (!fsSource(d.initializer)) continue;
    if (ts.isIdentifier(d.name)) ns.add(d.name.text);
    else if (ts.isObjectBindingPattern(d.name)) {
      for (const e of d.name.elements) if (WRITE_NAMES.has((e.propertyName ?? e.name).getText())) fnLocals.add(e.name.getText());
    }
  }
  const rootOf = (e: ts.Expression): string => {
    while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
    return ts.isIdentifier(e) ? e.text : '';
  };
  return find(sf, isCall).filter((c) => {
    const e = c.expression;
    if (ts.isIdentifier(e)) return fnLocals.has(e.text);
    if (ts.isPropertyAccessExpression(e)) return WRITE_NAMES.has(e.name.text) && ns.has(rootOf(e.expression));
    return false;
  });
}

describe('voice boundary', () => {
  it('(7) scans a non-vacuous file set including the required sources', () => {
    for (const r of REQUIRED) {
      const p = path.join(VOICE_DIR, r);
      expect(fs.existsSync(p), `${r} exists`).toBe(true);
      expect(fs.statSync(p).size, `${r} non-empty`).toBeGreaterThan(0);
    }
    expect(scanned.length).toBeGreaterThanOrEqual(REQUIRED.length);
    const rels = scanned.map((s) => s.rel);
    for (const r of REQUIRED) expect(rels).toContain(r);
    expect(rels.some((r) => r.startsWith('__fixtures__/'))).toBe(true);
  });

  it('(1) exactly one .listen( call, in voiceServer.ts, on opts.port/opts.host after assertBindableHost', () => {
    const listens: { s: Scanned; c: ts.CallExpression }[] = [];
    for (const s of scanned) {
      for (const c of find(s.sf, isCall)) {
        if (ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === 'listen') listens.push({ s, c });
      }
    }
    expect(listens.map((l) => here(l.s, l.c))).toHaveLength(1);
    const { s, c } = listens[0];
    expect(s.rel).toBe('voiceServer.ts');
    expect(c.arguments[0]?.getText()).toBe('opts.port');
    expect(c.arguments[1]?.getText()).toBe('opts.host');
    const guard = find(s.sf, isCall).filter((x) => calleeName(x) === 'assertBindableHost');
    expect(guard.some((g) => g.getStart() < c.getStart()), 'assertBindableHost( before listen(').toBe(true);
  });

  it('(2) every new WebSocketServer( / ws Server( (also aliased or namespaced) has noServer: true', () => {
    let seen = 0;
    for (const s of scanned) {
      const wsLocals = new Set<string>();
      for (const i of importsOf(s.sf).filter((x) => x.spec === 'ws')) {
        for (const b of i.bindings) if (b.imported === 'WebSocketServer' || b.imported === 'Server') wsLocals.add(b.local);
      }
      for (const n of find(s.sf, ts.isNewExpression)) {
        const ctor = n.expression.getText();
        if (!/(^|\.)(WebSocketServer|Server)$/.test(ctor) && !wsLocals.has(ctor)) continue;
        seen++;
        const o = n.arguments?.[0];
        const ok = !!o && isObj(o) && initText(prop(o, 'noServer')) === 'true';
        expect(ok, `noServer: true at ${here(s, n)}`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("(3) child_process only in voiceSession.ts; one spawn('claude') with the locked flags; execFile only taskkill", () => {
    for (const s of prod()) {
      const cp = importsOf(s.sf).filter((i) => i.spec === 'child_process' || i.spec === 'node:child_process');
      if (s.rel !== 'voiceSession.ts') expect(cp, `child_process in ${s.rel}`).toEqual([]);
      else {
        expect(cp).toHaveLength(1);
        expect(cp[0].defaultOrNs, 'no default/namespace child_process import').toBe(false);
        expect(cp[0].bindings.map((b) => `${b.imported}>${b.local}`).sort()).toEqual(['execFile>execFile', 'spawn>spawn']);
      }
    }
    // Banned process-launch calls apply to every scanned file, fixtures included.
    for (const s of scanned) {
      for (const c of find(s.sf, isCall)) {
        const n = calleeName(c);
        if (['execSync', 'execFileSync', 'spawnSync', 'fork'].includes(n) || (n === 'exec' && ts.isIdentifier(c.expression))) throw new Error(`${n}( at ${here(s, c)}`);
        if (n === 'execFile') expect(c.arguments[0]?.getText(), `execFile at ${here(s, c)}`).toBe("'taskkill'");
      }
    }
    // The fixture legitimately spawns a grandchild to exercise tree-kill; its program must be process.execPath.
    for (const s of scanned.filter((x) => x.fixture)) {
      for (const c of find(s.sf, isCall)) {
        if (calleeName(c) === 'spawn') expect(c.arguments[0]?.getText(), `fixture spawn at ${here(s, c)}`).toBe('process.execPath');
      }
    }
    for (const s of scanned) {
      for (const i of importsOf(s.sf)) expect(BANNED_MODULES.has(i.spec), `${s.rel} imports ${i.spec}`).toBe(false);
    }
    const sess = byName('voiceSession.ts');
    const spawnFnCalls = prod().flatMap((s) => find(s.sf, isCall).filter((c) => ts.isIdentifier(c.expression) && c.expression.text === 'spawnFn').map((c) => here(s, c)));
    expect(spawnFnCalls, 'exactly one spawnFn( call site').toHaveLength(1);
    expect(spawnFnCalls[0]).toMatch(/^voiceSession\.ts:/);
    const spawns = prod().flatMap((s) => find(s.sf, isCall).filter((c) => calleeName(c) === 'spawn').map((c) => ({ s, c })));
    expect(spawns.map((x) => here(x.s, x.c))).toHaveLength(1);
    expect(spawns[0].s.rel).toBe('voiceSession.ts');
    expect(spawns[0].c.arguments[0]?.getText()).toBe("'claude'");
    // spawn options reach spawn( through a wrapper, so check every options object that sets shell, and that one sets both.
    const withShell = find(sess.sf, isObj).filter((o) => prop(o, 'shell'));
    expect(withShell.length).toBeGreaterThan(0);
    for (const o of withShell) expect(initText(prop(o, 'shell')), 'shell').toBe('false');
    expect(withShell.some((o) => initText(prop(o, 'windowsHide')) === 'true'), 'windowsHide: true').toBe(true);
    const arrays = find(sess.sf, ts.isArrayLiteralExpression).filter((a) =>
      a.elements.some((e) => ts.isStringLiteral(e) && e.text === '--strict-mcp-config'));
    expect(arrays).toHaveLength(1);
    const strs = arrays[0].elements.filter(ts.isStringLiteral).map((e) => e.text);
    expect(strs).toContain('--no-session-persistence');
    // Forbidden flags are looked for in EVERY string piece of the file, not just the args array literal,
    // so args.push('--add-dir') or [...buildArgs(), '--add-dir', x] is caught.
    for (const { n, text } of stringPieces(sess.sf)) {
      for (const f of FORBIDDEN_FLAGS) expect(text.includes(f), `forbidden flag ${f} at ${here(sess, n)}`).toBe(false);
    }
    const pm = strs.indexOf('--permission-mode');
    if (pm >= 0) expect(strs[pm + 1], '--permission-mode value').toBe('manual');
    const at = strs.indexOf('--settings');
    expect(at).toBeGreaterThanOrEqual(0);
    let settings: { disableAllHooks?: unknown } = {};
    try { settings = JSON.parse(strs[at + 1]); } catch { /* asserted below */ }
    expect(settings.disableAllHooks, '--settings disableAllHooks').toBe(true);
  });

  it('(4) no pty, electron value, store/persistence imports and no fs write names', () => {
    for (const s of scanned) {
      for (const i of importsOf(s.sf)) {
        expect(isBannedModule(i.spec), `${s.rel} imports ${i.spec}`).toBe(false);
        if (i.spec === 'electron') expect(i.typeOnly, `${s.rel} value import of electron`).toBe(true);
        if (FS_MODULES.has(i.spec) && !i.typeOnly) {
          expect(i.defaultOrNs, `${s.rel} default/namespace import of ${i.spec}`).toBe(false);
          expect(i.names.filter((x) => WRITE_NAMES.has(x) || ['promises', 'open', 'openSync'].includes(x)), `${s.rel} fs write import`).toEqual([]);
        }
      }
      for (const c of fsWriteCalls(s.sf)) expect.fail(`fs write call at ${here(s, c)}`);
    }
  });

  it('(4c) fs write names only count when bound to fs (no false trips on truncate/link/rename lookalikes)', () => {
    const hits = (t: string): number => fsWriteCalls(parseSnippet(t)).length;
    expect(hits("function truncate(t: string, n: number) { return t.slice(0, n); }\ntruncate(text, 3);")).toBe(0);
    expect(hits('bus.link(x); x.rm(); registry.unlink(y);')).toBe(0);
    expect(hits('function rename() {}\nrename();')).toBe(0);
    expect(hits("import { truncateSync } from 'node:fs';\ntruncateSync(p, 3);")).toBe(1);
    expect(hits("import * as fs from 'node:fs';\nfs.rmSync(p);")).toBe(1);
    expect(hits("import fsp from 'node:fs/promises';\nawait fsp.writeFile(p, d);")).toBe(1);
    expect(hits("const f = require('fs');\nf.unlinkSync(p);")).toBe(1);
    expect(hits("const { rmSync } = require('node:fs');\nrmSync(p);")).toBe(1);
    expect(hits("const r = createRequire(import.meta.url);\nconst f = r('fs');\nf.mkdirSync(p);")).toBe(0);
    expect(hits("const f = createRequire(import.meta.url)('fs');\nf.mkdirSync(p);")).toBe(1);
    expect(hits("const m = await import('fs');\nm.cpSync(a, b);")).toBe(1);
  });

  it('(6b) process aliases are found; plain process.x and a local process() function are not', () => {
    const n = (t: string): number => processAliases(parseSnippet(t)).length;
    expect(n('const p = process;')).toBe(1);
    expect(n('const e = globalThis.process.env;')).toBe(1);
    expect(n("const e = globalThis['process'];")).toBe(1);
    expect(n('use(process);')).toBe(1);
    expect(n('const a = process.platform; const b = process.env.X; process.exit(0);')).toBe(0);
    expect(n('function process(f: boolean) { return f; }\nprocess(true);')).toBe(0);
  });

  it('(4b) pty module matching is segment based', () => {
    for (const ok of ['./emptyState', './sessionStore', '../remote/sessionStore', 'ws']) expect(isBannedModule(ok), ok).toBe(false);
    for (const bad of ['node-pty', '@lydell/node-pty', './ptyManager', '../ptyManager', './pty', './pty-host', './codexPty', '../terminalHub', '../collectorStore', './persistence']) {
      expect(isBannedModule(bad), bad).toBe(true);
    }
  });

  it("(5) no '0.0.0.0' or '::' literal", () => {
    for (const s of scanned) {
      for (const n of find(s.sf, ts.isStringLiteralLike)) {
        expect(['0.0.0.0', '::'].includes(n.text), `wildcard literal at ${here(s, n)}`).toBe(false);
      }
    }
  });

  it('(6) the child env comes only from buildAllowlistedChildEnv; process.env is never spread', () => {
    for (const s of scanned) {
      for (const n of find(s.sf, (x): x is ts.SpreadAssignment | ts.SpreadElement => ts.isSpreadAssignment(x) || ts.isSpreadElement(x))) {
        expect(isProcessEnv(n.expression), `spread at ${here(s, n)}`).toBe(false);
      }
    }
    for (const s of prod()) {
      for (const a of processAliases(s.sf)) expect.fail(`process alias at ${here(s, a)}`);
      for (const i of importsOf(s.sf)) expect(['process', 'node:process'].includes(i.spec), `${s.rel} imports ${i.spec}`).toBe(false);
      for (const d of find(s.sf, ts.isVariableDeclaration)) {
        const bad = ts.isObjectBindingPattern(d.name) && d.initializer?.getText() === 'process'
          && d.name.elements.some((e) => (e.propertyName ?? e.name).getText() === 'env');
        expect(bad, `const { env } = process at ${here(s, d)}`).toBe(false);
      }
      for (const n of find(s.sf, (x): x is ts.PropertyAccessExpression | ts.ElementAccessExpression => ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x))) {
        if (!isProcessEnv(n)) continue;
        const p = n.parent;
        const ok = ts.isCallExpression(p) && calleeName(p) === 'buildAllowlistedChildEnv';
        expect(ok, `process.env outside buildAllowlistedChildEnv( at ${here(s, n)}`).toBe(true);
      }
    }
    const sess = byName('voiceSession.ts');
    const decl = find(sess.sf, ts.isVariableDeclaration).find((d) => d.name.getText() === 'env');
    const envObj = decl?.initializer && ts.isObjectLiteralExpression(decl.initializer) ? decl.initializer : undefined;
    expect(envObj, 'env initialiser is an object literal').toBeDefined();
    const spreads = envObj!.properties.filter(ts.isSpreadAssignment);
    expect(spreads.map((x) => x.expression.getText())).toEqual(['buildAllowlistedChildEnv(process.env)']);
    for (const o of find(sess.sf, isObj)) {
      const e = prop(o, 'env');
      if (e) expect(ts.isShorthandPropertyAssignment(e) ? 'env' : initText(e), 'env option').toBe('env');
    }
  });

  it('(8) ClientMessage is the closed set of four t values', () => {
    const proto = byName('protocol.ts');
    const alias = find(proto.sf, ts.isTypeAliasDeclaration).find((a) => a.name.text === 'ClientMessage');
    expect(alias).toBeDefined();
    const members: ts.TypeNode[] = ts.isUnionTypeNode(alias!.type) ? [...alias!.type.types] : [alias!.type];
    const ts_: string[] = [];
    for (const m of members) {
      expect(ts.isTypeLiteralNode(m), `ClientMessage member ${m.getText()}`).toBe(true);
      const t = (m as ts.TypeLiteralNode).members.find((x) => x.name?.getText() === 't') as ts.PropertySignature | undefined;
      const lit = t?.type && ts.isLiteralTypeNode(t.type) && ts.isStringLiteral(t.type.literal) ? t.type.literal.text : undefined;
      expect(lit, 'literal t').toBeDefined();
      ts_.push(lit!);
    }
    expect([...ts_].sort()).toEqual(CLIENT_T);
  });

  it('(9) voiceGateway.ts and voiceConnection.ts import nothing from node:*', () => {
    const builtins = new Set(builtinModules);
    for (const n of ['voiceGateway.ts', 'voiceConnection.ts']) {
      const s = byName(n);
      for (const i of importsOf(s.sf)) {
        expect(i.spec.startsWith('node:') || builtins.has(i.spec), `${n} imports ${i.spec}`).toBe(false);
      }
    }
  });
});
