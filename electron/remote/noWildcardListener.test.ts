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
