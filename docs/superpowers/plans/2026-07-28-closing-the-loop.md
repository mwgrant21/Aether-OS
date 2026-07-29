# Closing the Loop (Stage 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace aether-os's entirely fictional approval queue with a real one, backed by Claude Code's actual `PermissionRequest` (allow/deny/edit scope) and `PostToolUse` (anomaly-triggered flag-and-block) hooks, scoped to Aether's own tracked session only.

**Architecture:** A new local HTTP server in Electron's main process (`electron/permissionServer.ts`) is the single synchronous rendezvous point. A new Node hook script (`scripts/aether-permission-hook.mjs`, following the existing `aether-hook-emit.mjs` precedent) is registered via a new installer function in `collector/src/hookInstaller.ts`, checks the incoming `session_id` against Stage 4's `own-session.json`, and POSTs to the local server — falling through non-blocking on any mismatch or connection failure. `PermissionRequest` always surfaces a real approval card in the renderer. `PostToolUse` runs Stage 5's existing anomaly detectors on-demand (via `liveAgentTracker`'s existing public `tick()`, not new internals) before ever showing UI — a clean pass returns instantly with zero added latency; a tripped detector holds open and shows a flag card.

**Tech Stack:** TypeScript, Node's built-in `http` module (no new dependency), Electron IPC (`ipcMain.handle`/`ipcRenderer.invoke`), React, Vitest.

## Global Constraints

- **Session scope: Aether's own tracked session only.** The hook script checks `session_id` (from the hook's stdin JSON) against `readOwnSessionId(ownSessionFilePath)` (`collector/src/ownSessionFile.ts`, already exists from Stage 4). A mismatch or `null` falls through non-blocking — same code path as "app not running."
- **App-not-running / any failure fallback: non-blocking fall-through, never default-deny, never hang.** The hook script must never cause Claude Code to wait indefinitely or silently deny when Aether just isn't running.
- **IPC mechanism: local HTTP server in Electron's main process**, port written to `~/.aether-os/permission-server-port` (matches the existing `.aether-os` file-discovery convention — see `main.ts`'s `statuslinePayloadPath`/`collectorDbPath` consts).
- **Risk tiering is styling/urgency only — no auto-approve in this stage.** Every `PermissionRequest` always shows the user a prompt.
- **`PostToolUse` never blocks by default.** It runs the Stage 5 detectors (`detectReReadLoop`, `detectWriteDeleteRewrite`, `detectZeroEditBurn` from `src/shared/anomalyDetectors.ts`) via `tracker.tick()`'s existing `anomalies` output before ever surfacing UI. Only a detector hit (matched by `toolUseId`) holds the request open for manual review.
- **Timeouts:** `PermissionRequest` holds up to 120s before auto-deny with a timeout reason (well under Claude Code's own 600s hook-process cap). `PostToolUse` flag-review holds up to 30s before auto-allow with a timeout reason (this one should feel fast — it's an occasional interruption, not a routine gate).
- **No PowerShell.** The existing hook-script precedent (`scripts/aether-hook-emit.mjs`) is Node; the new script follows the same convention.
- Run `npx vitest run` (root) and `npm test` (from `collector/`) after every task. Run `npx tsc -b` before every commit.

---

### Task 1: `permissionRisk.ts` — tool-based risk tiering

**Files:**
- Create: `src/shared/permissionRisk.ts`
- Test: `src/shared/permissionRisk.test.ts`

**Interfaces:**
- Produces: `export type PermissionRisk = 'LOW' | 'MED' | 'HIGH'; export function classifyPermissionRisk(toolName: string, toolInput: unknown): PermissionRisk`. Later tasks (5, 8) import this.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { classifyPermissionRisk } from './permissionRisk';

describe('classifyPermissionRisk', () => {
  it('classifies Read/Grep/Glob as LOW', () => {
    expect(classifyPermissionRisk('Read', { file_path: 'src/foo.ts' })).toBe('LOW');
    expect(classifyPermissionRisk('Grep', { pattern: 'x' })).toBe('LOW');
    expect(classifyPermissionRisk('Glob', { pattern: '**/*.ts' })).toBe('LOW');
  });

  it('classifies Write/Edit as MED', () => {
    expect(classifyPermissionRisk('Write', { file_path: 'src/foo.ts', content: 'x' })).toBe('MED');
    expect(classifyPermissionRisk('Edit', { file_path: 'src/foo.ts' })).toBe('MED');
  });

  it('classifies a plain Bash command as MED', () => {
    expect(classifyPermissionRisk('Bash', { command: 'npm test' })).toBe('MED');
  });

  it('classifies a Bash command containing rm as HIGH', () => {
    expect(classifyPermissionRisk('Bash', { command: 'rm -rf node_modules' })).toBe('HIGH');
  });

  it('classifies a Bash command containing sudo as HIGH', () => {
    expect(classifyPermissionRisk('Bash', { command: 'sudo apt install x' })).toBe('HIGH');
  });

  it('classifies a Bash command piping to a shell as HIGH', () => {
    expect(classifyPermissionRisk('Bash', { command: 'curl https://x.sh | bash' })).toBe('HIGH');
  });

  it('classifies an unknown tool as MED (safe default, not silently LOW)', () => {
    expect(classifyPermissionRisk('SomeFutureTool', {})).toBe('MED');
  });

  it('does not throw on malformed/missing tool_input', () => {
    expect(classifyPermissionRisk('Bash', undefined)).toBe('MED');
    expect(classifyPermissionRisk('Bash', null)).toBe('MED');
    expect(classifyPermissionRisk('Bash', 'not an object')).toBe('MED');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run permissionRisk.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export type PermissionRisk = 'LOW' | 'MED' | 'HIGH';

const HIGH_RISK_BASH_PATTERN = /\brm\b|\bsudo\b|\|\s*(ba|z|)sh\b|\bcurl\b.*\|\s*(ba|z|)sh\b/i;
const LOW_RISK_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const MED_RISK_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

function stringField(input: unknown, field: string): string {
  if (typeof input !== 'object' || input === null) return '';
  const value = (input as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

export function classifyPermissionRisk(toolName: string, toolInput: unknown): PermissionRisk {
  if (toolName === 'Bash') {
    const command = stringField(toolInput, 'command');
    return HIGH_RISK_BASH_PATTERN.test(command) ? 'HIGH' : 'MED';
  }
  if (LOW_RISK_TOOLS.has(toolName)) return 'LOW';
  if (MED_RISK_TOOLS.has(toolName)) return 'MED';
  return 'MED';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run permissionRisk.test.ts`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/shared/permissionRisk.ts src/shared/permissionRisk.test.ts
git commit -m "feat: add tool-based permission risk classifier"
```

---

### Task 2: `electron/permissionServer.ts` — the local HTTP server core

**Files:**
- Create: `electron/permissionServer.ts`
- Test: `electron/permissionServer.test.ts`

**Interfaces:**
- Consumes: nothing new (pure server logic — the anomaly-detection wiring for `/post-tool-flag-check` is Task 6, not this task).
- Produces:
  ```ts
  export interface PermissionRequestPayload {
    requestId: string;
    toolName: string;
    toolInput: unknown;
    risk: PermissionRisk;
  }
  export interface PermissionDecision {
    behavior: 'allow' | 'deny';
    updatedInput?: unknown;
    reason?: string;
  }
  export function startPermissionServer(options: {
    port: number;
    onPermissionRequest: (req: { toolName: string; toolInput: unknown }) => Promise<PermissionDecision>;
    timeoutMs: number;
  }): { server: http.Server; port: number; stop: () => void }
  export function resolvePendingRequest(requestId: string, decision: PermissionDecision): boolean
  ```
  Later tasks (3, 5, 6) build on this — `onPermissionRequest` is the seam Task 5 wires to the renderer via IPC, and `/post-tool-flag-check`'s own callback (added in Task 6) follows the identical pattern.

This task builds the server shape with a **stub** `onPermissionRequest` behavior proven by tests (the callback is injected, so tests don't need real IPC/UI) — deferring the real renderer wiring to Task 5 keeps this task's test surface small and mechanical.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { startPermissionServer } from './permissionServer';

function postJson(port: number, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('permissionServer', () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    if (stop) stop();
    stop = null;
  });

  it('resolves POST /permission-request with the decision returned by onPermissionRequest', async () => {
    const started = startPermissionServer({
      port: 0,
      timeoutMs: 5000,
      onPermissionRequest: async () => ({ behavior: 'allow' as const }),
    });
    stop = started.stop;
    const res = await postJson(started.port, '/permission-request', { toolName: 'Read', toolInput: { file_path: 'x' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ behavior: 'allow' });
  });

  it('propagates a deny decision with a reason', async () => {
    const started = startPermissionServer({
      port: 0,
      timeoutMs: 5000,
      onPermissionRequest: async () => ({ behavior: 'deny' as const, reason: 'nope' }),
    });
    stop = started.stop;
    const res = await postJson(started.port, '/permission-request', { toolName: 'Bash', toolInput: { command: 'rm -rf /' } });
    expect(res.body).toEqual({ behavior: 'deny', reason: 'nope' });
  });

  it('propagates updatedInput when the decision includes it', async () => {
    const started = startPermissionServer({
      port: 0,
      timeoutMs: 5000,
      onPermissionRequest: async () => ({ behavior: 'allow' as const, updatedInput: { file_path: 'src/**' } }),
    });
    stop = started.stop;
    const res = await postJson(started.port, '/permission-request', { toolName: 'Write', toolInput: { file_path: 'src/x.ts' } });
    expect(res.body.updatedInput).toEqual({ file_path: 'src/**' });
  });

  it('auto-denies with a timeout reason when onPermissionRequest never resolves within timeoutMs', async () => {
    const started = startPermissionServer({
      port: 0,
      timeoutMs: 50,
      onPermissionRequest: () => new Promise(() => {}), // never resolves
    });
    stop = started.stop;
    const res = await postJson(started.port, '/permission-request', { toolName: 'Read', toolInput: {} });
    expect(res.body.behavior).toBe('deny');
    expect(res.body.reason).toMatch(/timeout/i);
  });

  it('returns 400 on malformed request body', async () => {
    const started = startPermissionServer({ port: 0, timeoutMs: 5000, onPermissionRequest: async () => ({ behavior: 'allow' as const }) });
    stop = started.stop;
    const res = await postJson(started.port, '/permission-request', { notToolName: true });
    expect(res.status).toBe(400);
  });

  it('a request to an unknown path returns 404', async () => {
    const started = startPermissionServer({ port: 0, timeoutMs: 5000, onPermissionRequest: async () => ({ behavior: 'allow' as const }) });
    stop = started.stop;
    const res = await postJson(started.port, '/nonexistent', {});
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/permissionServer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import http from 'node:http';
import type { PermissionRisk } from '../src/shared/permissionRisk';

export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  reason?: string;
}

export interface StartPermissionServerOptions {
  port: number;
  timeoutMs: number;
  onPermissionRequest: (req: { toolName: string; toolInput: unknown }) => Promise<PermissionDecision>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(onTimeout());
      }
    }, timeoutMs);
    promise.then((value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    });
  });
}

export function startPermissionServer(options: StartPermissionServerOptions): { server: http.Server; port: number; stop: () => void } {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/permission-request') {
      res.writeHead(404).end();
      return;
    }

    let parsed: { toolName?: unknown; toolInput?: unknown };
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (typeof parsed.toolName !== 'string') {
      res.writeHead(400).end();
      return;
    }

    const decision = await withTimeout(
      options.onPermissionRequest({ toolName: parsed.toolName, toolInput: parsed.toolInput }),
      options.timeoutMs,
      () => ({ behavior: 'deny' as const, reason: 'permission request timed out waiting for a decision' })
    );

    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(decision));
  });

  server.listen(options.port);
  const actualPort = options.port === 0 ? (server.address() as { port: number }).port : options.port;

  return {
    server,
    port: actualPort,
    stop: () => server.close(),
  };
}
```

Note: `server.listen(0)` before reading `server.address()` requires listening to complete first in a real deployment (Task 3 wires this into `app.whenReady()` and awaits a `'listening'` event before writing the port file) — the test suite's `port: 0` usage works because the test `postJson` calls happen after `startPermissionServer` returns synchronously with a port already resolved via the synchronous `server.address()` call, which is valid once `.listen()` has been called (Node's `http.Server` assigns the port synchronously within the same tick for `127.0.0.1`/loopback in practice, but if this proves flaky in CI, wrap the return in a `'listening'` event promise — flag this in your report if the test suite shows any flakiness).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/permissionServer.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add electron/permissionServer.ts electron/permissionServer.test.ts
git commit -m "feat(electron): add local HTTP permission server core"
```

---

### Task 3: Wire `permissionServer` into `main.ts` lifecycle + port-file discovery

**Files:**
- Modify: `electron/main.ts`

**Interfaces:**
- Consumes: `startPermissionServer` (Task 2).
- Produces: a running server on app launch, stopped on quit, with its port written to `~/.aether-os/permission-server-port` for the hook script (Task 4) to discover.

- [ ] **Step 1: Add the port-file path constant and permission-server state**

Alongside `statuslinePayloadPath` (main.ts:134), add:

```ts
const permissionServerPortPath = join(os.homedir(), '.aether-os', 'permission-server-port');
```

Alongside `stopStatuslineWatcher` (main.ts:143):

```ts
let stopPermissionServer: (() => void) | null = null;
```

- [ ] **Step 2: Start the server in `app.whenReady()`, stop it in `before-quit`**

Alongside the `startStatuslineWatcher` call (main.ts:287), add (using a placeholder `onPermissionRequest` that always denies — Task 5 replaces this with the real renderer round-trip):

```ts
const permission = startPermissionServer({
  port: 51823, // arbitrary fixed high port; bump-on-conflict handled in Step 3 below
  timeoutMs: 120000,
  onPermissionRequest: async () => ({ behavior: 'deny', reason: 'permission UI not yet wired (Task 5)' }),
});
stopPermissionServer = permission.stop;
await fsp.mkdir(dirname(permissionServerPortPath), { recursive: true });
await fsp.writeFile(permissionServerPortPath, String(permission.port), 'utf8');
```

Alongside `stopStatuslineWatcher()`'s call in `before-quit` (main.ts:299-301), add:

```ts
if (stopPermissionServer) {
  stopPermissionServer();
  stopPermissionServer = null;
}
```

- [ ] **Step 3: Handle port conflict**

`server.listen(51823)` can fail with `EADDRINUSE` (e.g. a second Aether instance, or a leftover process). Wrap the `startPermissionServer` call: listen for the server's `'error'` event before the port-file write, and on `EADDRINUSE` retry once with `port: 0` (ephemeral) so app launch never crashes on this — write whatever port was actually bound. Add a one-line comment explaining why (mirrors this project's existing "never let infra startup crash the whole app" convention, e.g. the statusline watcher's own defensive design).

- [ ] **Step 4: Manual verification note**

This step can't be automated (no display in this dev environment, matching Stage 4/5's disclosed limitation) — note in your task report that `npm run electron:dev` + inspecting `~/.aether-os/permission-server-port` for a real port number, and confirming the app quits cleanly (server actually releases the port), needs verification whenever a non-headless environment is available. Do not claim this was manually verified if it wasn't.

- [ ] **Step 5: Typecheck and run the full test suite**

Run: `npx tsc -b` and `npx vitest run`.
Expected: clean, no regressions (this task adds no new automated tests of its own — the server logic is already covered by Task 2; this task is pure wiring).

- [ ] **Step 6: Commit**

```bash
git add electron/main.ts
git commit -m "feat(electron): start permission server on launch, write discoverable port file"
```

---

### Task 4: `scripts/aether-permission-hook.mjs` — the hook script

**Files:**
- Create: `scripts/aether-permission-hook.mjs`
- Create: `scripts/aether-permission-hook.test.mjs` (or `.test.ts` if the existing `aether-hook-emit` test uses `.ts` — check `scripts/aether-hook-emit.test.ts`'s actual extension/runner setup first and match it exactly)

**Interfaces:**
- Consumes: `own-session.json` via the same read pattern `collector/src/ownSessionFile.ts`'s `readOwnSessionId` uses (read that file first — this script is a standalone Node process, not a TS module import, so port the read logic inline or import from a compiled path; check how `aether-hook-emit.mjs` itself imports/requires shared logic, if at all, and match that pattern).
- Produces: stdin JSON → stdout JSON / exit code, per Claude Code's real `PermissionRequest` contract (see the design spec's "Verified real infrastructure" section for the exact shapes).

- [ ] **Step 1: Read `scripts/aether-hook-emit.mjs` in full first**

This is the structural precedent — match its stdin-reading pattern, its error-handling/exit-code discipline, and whatever module system it uses (check if it's plain CommonJS-style `require` or ESM `import` — `.mjs` implies ESM, confirm).

- [ ] **Step 2: Write the failing test(s)**

Test at minimum: (a) a session-id mismatch against a fixture `own-session.json` causes non-blocking fall-through (exit code that is neither 0-with-JSON nor 2 — check the real contract for what "do nothing, let Claude Code's default behavior happen" actually is; if ambiguous, prefer exiting 0 with no stdout, since the docs describe exit 0 as "parses JSON from stdout" — an empty/no-JSON stdout on exit 0 should be tested against the real hook contract's tolerance, and if genuinely undocumented behavior, note this explicitly as a risk in your report rather than guessing silently); (b) an unreachable server (nothing listening on the discovered port) also falls through non-blocking within a short timeout, not hanging; (c) a real decision from a running fixture server (spin up a minimal `http.createServer` in the test itself, matching Task 2's server shape) round-trips correctly into the exact stdout JSON shape Claude Code expects.

- [ ] **Step 3: Run to verify failure, implement, run to verify pass**

Follow this project's TDD convention throughout. The script must: read stdin JSON fully before proceeding (matching Claude Code's actual invocation — stdin is piped and closed at EOF), read `permission-server-port` from `~/.aether-os/`, read `own-session.json` and compare `session_id`, POST to the local server with a short overall timeout for the "is the app even reachable" case distinct from the full 120s decision-wait timeout (the connect attempt itself should fail fast, e.g. within 1-2s, if nothing is listening — Node's default TCP connect timeout may be too long; set an explicit connection timeout), and translate the JSON response into the exact `hookSpecificOutput`/`decision` shape from the design spec, exiting 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/aether-permission-hook.mjs scripts/aether-permission-hook.test.mjs
git commit -m "feat: add PermissionRequest hook script (session-scoped, falls through non-blocking)"
```

---

### Task 5: Renderer approval UI + IPC round-trip (wires Task 2's stub callback for real)

**Files:**
- Modify: `electron/main.ts` (replace Task 3's stub `onPermissionRequest`)
- Modify: `electron/preload.ts`
- Modify: `src/aetherElectron.d.ts`
- Modify: `src/state/types.ts`
- Modify: `src/state/reducer.ts`
- Create: `src/state/usePermissionRequestSync.ts`
- Create: `src/components/agents/PermissionRequestCard.tsx`
- Create: `src/components/agents/PermissionRequestCard.test.tsx`
- Modify: wherever `useFleetSync()`/`useDiagnosticsSync()` are called (`src/App.tsx`) — add the new hook alongside them

**Interfaces:**
- Consumes: `startPermissionServer`'s `onPermissionRequest` seam (Task 2/3), `classifyPermissionRisk` (Task 1).
- Produces: `state.pendingPermissionRequest: PermissionRequestUI | null`, an `ipcMain.handle('permission:respond', ...)`/`ipcRenderer.invoke('permission:respond', ...)` pair (following `optimize:apply`'s exact precedent shape — read `main.ts:353`/`preload.ts:90` first).

- [ ] **Step 1: Define `PermissionRequestUI` in `src/state/types.ts`**

```ts
export interface PermissionRequestUI {
  requestId: string;
  toolName: string;
  toolInput: unknown;
  risk: PermissionRisk; // from src/shared/permissionRisk
  editableField: { label: string; value: string } | null; // e.g. { label: 'command', value: 'rm -rf x' } for Bash, { label: 'file path', value: 'src/foo.ts' } for Read/Write/Edit
}
```

Add `pendingPermissionRequest: PermissionRequestUI | null` to the state interface.

- [ ] **Step 2: Wire `main.ts`'s permission server to push a pending request to the renderer and wait for a response**

Replace Task 3's stub `onPermissionRequest` with one that: generates a `requestId`, classifies risk via `classifyPermissionRisk`, derives the editable field (a small pure helper — Bash → `{label: 'command', value: toolInput.command}`; Read/Write/Edit/NotebookEdit → `{label: 'file path', value: toolInput.file_path}`; else `null`), pushes `{requestId, toolName, toolInput, risk, editableField}` to the renderer via `sendToWindow('permission:request', ...)`, and returns a Promise that resolves when `ipcMain.handle('permission:respond', ...)` is called with that `requestId` (use a `Map<requestId, resolveFn>` in module scope, matching the pattern `permissionServer.ts`'s own `withTimeout`/pending-request bookkeeping already established — keep this resolution map in `main.ts`, not inside `permissionServer.ts`, since it's specifically about bridging to the renderer).

Add the extraction helper as a small local function in `main.ts` (or a new `src/shared/permissionEditableField.ts` pure module with its own test if you'd rather keep `main.ts` thin — prefer the separate testable module given this project's convention of keeping `main`/`renderer` thin and pushing logic into `src/shared/`).

- [ ] **Step 3: Add the IPC channel**

`electron/preload.ts`: add a `permission` block mirroring `diagnostics`'s `onSnapshot` shape for the push (`permission.onRequest(callback)`), plus an `invoke`-style `permission.respond(requestId, decision)` mirroring `optimize:apply`'s exact call shape.

- [ ] **Step 4: `src/state/reducer.ts`** — add `SET_PENDING_PERMISSION_REQUEST` action + case, mirroring `SET_DIAGNOSTICS`'s exact shape.

- [ ] **Step 5: `src/state/usePermissionRequestSync.ts`** — mirror `useDiagnosticsSync.ts` exactly for the push side.

- [ ] **Step 6: Write the failing component test, then implement `PermissionRequestCard.tsx`**

Test cases: renders nothing when `pendingPermissionRequest` is `null`; renders tool name, risk badge, and the editable field pre-filled with its value when present; clicking Approve calls the respond IPC with `{behavior: 'allow', updatedInput: <edited value mapped back into the right tool_input key>}`; clicking Deny calls it with `{behavior: 'deny', reason: <a required, non-empty reason — do not allow submitting an empty deny reason>}`.

Mount `<PermissionRequestCard />` in `AgentsView.tsx` (or wherever a persistent app-level card belongs — check if `FleetCard`/`DispatchTimeline` are already project-scoped to `AgentsView` vs. something more global like `App.tsx`; a permission prompt arguably needs to be visible from any tab, not just Agents — read `App.tsx`'s layout structure first and place this at whatever level ensures it's always visible, not just on one tab. This may mean mounting it in `App.tsx` itself rather than `AgentsView.tsx` — use your judgment based on what you find, and note the choice in your report).

- [ ] **Step 7: Run the full test suite and typecheck**

Run: `npx vitest run` and `npx tsc -b`.
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add electron/main.ts electron/preload.ts src/aetherElectron.d.ts src/state/types.ts src/state/reducer.ts src/state/usePermissionRequestSync.ts src/components/agents/PermissionRequestCard.tsx src/components/agents/PermissionRequestCard.test.tsx src/App.tsx
git commit -m "feat: real PermissionRequest approval UI wired end-to-end through the permission server"
```

---

### Task 6: `/post-tool-flag-check` — anomaly-triggered PostToolUse review

**Files:**
- Modify: `electron/permissionServer.ts` (add the second endpoint)
- Modify: `electron/permissionServer.test.ts`
- Modify: `electron/main.ts` (wire the tracker + timeout)

**Interfaces:**
- Consumes: `liveAgentTracker`'s existing public `tick(): Promise<LiveAgentTick>` (already returns `anomalies: Anomaly[]` with `toolUseId` — no changes needed to `liveAgentTracker.ts` itself).
- Produces: `POST /post-tool-flag-check` — same server, new route, same pending-Promise/timeout pattern as `/permission-request` but with a 30s timeout and an auto-**allow** (not deny) on timeout, per this stage's own asymmetry decision (a stuck review shouldn't block Claude any more than necessary for a soft, occasional-flag feature).

- [ ] **Step 1: Write the failing tests** in `permissionServer.test.ts`, extending the existing suite:

```ts
it('POST /post-tool-flag-check calls onPostToolUse and returns its decision when a detector trips', async () => {
  const started = startPermissionServer({
    port: 0, timeoutMs: 5000,
    onPermissionRequest: async () => ({ behavior: 'allow' as const }),
    onPostToolUse: async () => ({ block: true, reason: 'reReadLoop: src/foo.ts read 3 times' }),
  });
  stop = started.stop;
  const res = await postJson(started.port, '/post-tool-flag-check', { toolUseId: 'tu_1', toolName: 'Read', toolOutput: 'x' });
  expect(res.body).toEqual({ block: true, reason: 'reReadLoop: src/foo.ts read 3 times' });
});

it('auto-allows (not deny) on /post-tool-flag-check timeout', async () => {
  const started = startPermissionServer({
    port: 0, timeoutMs: 5000,
    onPermissionRequest: async () => ({ behavior: 'allow' as const }),
    onPostToolUse: () => new Promise(() => {}),
    postToolUseTimeoutMs: 50,
  });
  stop = started.stop;
  const res = await postJson(started.port, '/post-tool-flag-check', { toolUseId: 'tu_1', toolName: 'Read', toolOutput: 'x' });
  expect(res.body.block).toBe(false);
  expect(res.body.reason).toMatch(/timeout/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run electron/permissionServer.test.ts`
Expected: FAIL — `onPostToolUse`/`postToolUseTimeoutMs` not in the options type, route doesn't exist.

- [ ] **Step 3: Extend `startPermissionServer`**

Add `onPostToolUse: (req: { toolUseId: string; toolName: string; toolOutput: unknown }) => Promise<{ block: boolean; reason?: string }>` and `postToolUseTimeoutMs: number` to `StartPermissionServerOptions`, and a second route branch in the request handler for `POST /post-tool-flag-check`, reusing the same `readBody`/`withTimeout` helpers with `{ block: false, reason: 'post-tool-use review timed out' }` as the timeout fallback.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run electron/permissionServer.test.ts`
Expected: PASS, all tests (old + new) green.

- [ ] **Step 5: Wire `main.ts`'s real `onPostToolUse`**

This is the detector-check seam: `async ({ toolUseId }) => { const tick = await tracker.tick(); const tripped = tick.anomalies.find(a => a.toolUseId === toolUseId); if (!tripped) return { block: false }; /* else push a flag-review card to the renderer via the same pending-Map/IPC pattern Task 5 established, and await the user's decision */ }`. This reuses `liveAgentTracker`'s already-public `tick()` — no changes to `liveAgentTracker.ts` needed. The "push to renderer and await" half of this reuses Task 5's IPC plumbing pattern (a second `PermissionRequestUI`-like shape, or extend the existing one with a `kind: 'permission' | 'postToolFlag'` discriminant — your call on the cleanest shape, but do not duplicate the whole IPC channel/hook pair if extending the existing one is straightforward).

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `npx vitest run` and `npx tsc -b`.
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add electron/permissionServer.ts electron/permissionServer.test.ts electron/main.ts
git commit -m "feat: anomaly-triggered PostToolUse flag-and-block review, zero latency on clean calls"
```

---

### Task 7: Hook script PostToolUse support + installer

**Files:**
- Modify: `scripts/aether-permission-hook.mjs` (Task 4) — add PostToolUse handling
- Modify: `collector/src/hookInstaller.ts`
- Modify: `collector/src/hookInstaller.test.ts`

**Interfaces:**
- Consumes: `/post-tool-flag-check` (Task 6).
- Produces: `installPermissionHooks(settingsPath, scriptPath): Promise<{ok, backupPath?, error?}>`, a new exported function alongside the existing `installHooks`/`uninstallHooks`, targeting `['PermissionRequest', 'PostToolUse']` with a distinct marker (e.g. `'aether-permission-hook.mjs'`) so it coexists with the existing `aether-hook-emit.mjs` group already occupying `PostToolUse`.

- [ ] **Step 1: Extend the hook script**

The script must branch on `hook_event_name` from its stdin JSON: `PermissionRequest` → existing Task 4 behavior; `PostToolUse` → POST to `/post-tool-flag-check` instead, with its own separate short "is the app reachable" check (same fallback discipline), and translate the response into the real `PostToolUse` stdout contract (`"decision": "block"` string field, per the design spec — NOT the same JSON shape as `PermissionRequest`'s response).

- [ ] **Step 2: Write the failing test for the new branch**, following Task 4's test file's existing structure and fixture-server pattern.

- [ ] **Step 3: Implement, run to verify pass.**

- [ ] **Step 4: Write the failing test for `installPermissionHooks`** in `hookInstaller.test.ts`, following the existing `installHooks`/`uninstallHooks` tests' real-temp-file-round-trip convention (not mocks) — assert it adds `PermissionRequest` (new) and appends a second group to `PostToolUse` (coexisting with a pre-existing `aether-hook-emit.mjs` group, if one is already installed in the fixture) without disturbing it, and that it's idempotent (calling twice doesn't duplicate).

- [ ] **Step 5: Implement `installPermissionHooks`/`uninstallPermissionHooks`**, reusing the existing `readSettings`/`writeBackup`/`writeSettingsAtomically`/`isOurGroup` helpers already in the file (they're already parameterized by `scriptPath` — only the exported function names, the event list (`['PermissionRequest', 'PostToolUse']` instead of `MANAGED_HOOK_EVENTS`), and the uninstall marker string are new).

- [ ] **Step 6: Run the full collector test suite and typecheck**

Run (from `collector/`): `npm test` and `npx tsc -b`.
Expected: all green, existing `installHooks`/`uninstallHooks` tests unaffected.

- [ ] **Step 7: Commit**

```bash
git add scripts/aether-permission-hook.mjs collector/src/hookInstaller.ts collector/src/hookInstaller.test.ts
git commit -m "feat: PostToolUse hook-script support, installPermissionHooks alongside the existing installer"
```

---

### Task 8: Retire (or explicitly keep) the fictional `Approval` system

**Files:**
- Read first, full list before deciding scope: `src/state/persistence.ts`, `src/state/chatActionResult.ts` (+test), `src/components/chat/useChatChannels.ts`, `src/components/chat/systemPrompt.ts` (+test), `src/components/chat/localResponder.ts`, `src/components/dashboard/SystemsCard.tsx`, `src/components/layout/TopBar.tsx`, `src/components/terminal/commands.ts`, `src/state/reducer.ts`, `src/state/reducer.test.ts`, `src/state/tick.ts`, `src/state/tick.test.ts`, `src/state/actionExecutor.ts`, `src/state/types.ts`

This task is deliberately scoped as investigate-then-decide, matching this project's own precedent (e.g. Stage 5's Task 5) for cases where the correct action depends on what's actually found, not what's assumed. Do not guess at the disposition of the 17 files above before reading them.

- [ ] **Step 1: Read every file listed above.** For each, determine: is `Approval`/`ADD_APPROVAL`/`state.approvals` load-bearing to a still-relevant feature (the chat action-JSON pipeline, terminal commands, the TopBar bell as a UI affordance), or is it purely part of the fictional simulation (`tick.ts`'s random generator) that Stage 6 makes redundant?

- [ ] **Step 2: Write a short decision note** (as a code comment at the top of `src/state/types.ts`'s `Approval` interface, or as a PROGRESS.md entry if the finding is substantial enough) stating what was found and the disposition chosen: full removal, partial removal (e.g. keep the type but retire only the random-simulation generator in `tick.ts`), or keep-as-is with reasoning for why the fictional and real systems can coexist (e.g. if `Approval` genuinely serves a different, still-needed purpose like chat-driven risky-verb confirmations distinct from tool-call permission gating).

- [ ] **Step 3: Execute the chosen disposition** — remove/modify only what Step 1/2 concluded, with tests updated to match (removing dead test coverage for anything deleted, not leaving stale tests that reference removed code).

- [ ] **Step 4: Run the full test suite and typecheck**

Run: `npx vitest run` and `npx tsc -b`.
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: retire/reconcile the fictional Approval system now that real PermissionRequest approvals exist"
```

(Adjust the commit message to reflect the actual disposition chosen in Step 2 — do not claim "retire" if the actual decision was "keep, coexists.")

---

### Task 9: Roadmap/PROGRESS closeout

**Files:**
- Modify: `README.md` (if a portfolio-relevant screenshot/GIF is feasible — see the headless-environment note below)
- Modify: `docs/roadmap.md`
- Modify: `PROGRESS.md`

- [ ] **Step 1: Screenshot/GIF** — same disclosed limitation as Stage 4/5: this dev environment is headless, with no display to launch `npm run electron:dev` against and no way to trigger a real `PermissionRequest`/`PostToolUse` hook without a live Claude Code session driving Aether's own pty. Defer, name plainly, matching Stage 5's exact precedent phrasing.

- [ ] **Step 2: Update `docs/roadmap.md`'s Stage 6 row** to `**Status: shipped**`, matching the Stage 3/4/5 phrasing convention, with a pointer to this plan file and a note on what's deferred (fleet-wide control, auto-approve by risk tier — both explicitly out of scope per the design spec).

- [ ] **Step 3: Add a PROGRESS.md entry** following the established convention — what shipped (real `PermissionRequest`/`PostToolUse` approval console, session-scoped, editable-scope per-tool-aware field, anomaly-triggered PostToolUse review with zero added latency on clean calls), the `Approval`-system disposition from Task 8 (named plainly, whatever it turned out to be), and what's deferred (screenshot/GIF, fleet-wide scope, auto-approve).

- [ ] **Step 4: Final whole-repo verification pass**

Run from repo root: `npx tsc -b`, `npm run build`, `npx vitest run`. Run from `collector/`: `npm run build`, `npm test`. Attempt `npm run electron:build` and report the actual result.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/roadmap.md PROGRESS.md
git commit -m "docs: Stage 6 (Closing the Loop) shipped — roadmap/PROGRESS closeout"
```
