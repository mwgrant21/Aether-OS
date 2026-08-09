# Subscription-Only Codex Cross-Engine Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator manually trigger Codex, via ACP and the operator's own
ChatGPT subscription, to check whether a completed dispatch's artifacts actually
support its claim — with paid OpenAI API billing structurally impossible.

**Architecture:** Electron main owns a pinned `codex-acp` child process, spawned with
an allowlisted environment and a dedicated `CODEX_HOME`, communicating over ACP/JSON-RPC
on stdio. A policy module permits only `chat-gpt` authentication and fails closed on
every other status, rechecked before every run. A snapshot builder exports an isolated,
read-only copy of the selected dispatch's project (baseline + approved diff, never the
live tree) for Codex to inspect. The renderer only ever supplies a dispatch ID; main
resolves the claim (on demand from the dispatch's own transcript file, never persisted),
the exact touched-file list (via a new tool-call → source-file correlation), and the
project root, then returns a structured, validated verdict.

**Tech Stack:** TypeScript (strict), Electron main process, `node:child_process`,
`@agentclientprotocol/codex-acp` (pinned, no `npx`), Vitest.

## Global Constraints

- Full spec: `docs/superpowers/specs/2026-08-07-codex-acp-subscription-verification.md`.
  Read it in full before writing code — this plan sequences it, it does not replace it.
- **The only allowed Codex authentication status is `{ type: 'chat-gpt' }`.** Every other
  status (`api-key`, `gateway`, `unauthenticated`, unknown, malformed, timeout) blocks
  verification. Fail closed, always — a missing method or ambiguous reply is never
  permission to continue.
- **No fallback, ever.** No API-key field in the UI, no reading `OPENAI_API_KEY` /
  `CODEX_API_KEY` from anywhere (settings, `.env`, registry, credential manager,
  inherited `process.env`), no custom gateway, no automatic quota-failure retry through
  a different route.
- **Electron main owns the adapter exclusively.** The renderer supplies a dispatch ID
  only — never a path, ACP method, auth method, executable, or provider. Main validates
  and resolves everything.
- **Never point Codex at the live working tree.** Every verification runs against an
  isolated temporary snapshot (committed baseline + the selected diff), removed after
  success, failure, cancellation, timeout, or app shutdown.
- **Nothing raw is persisted.** No prompt, diff, source file, claim text, or raw Codex
  response enters SQLite, the global reducer store, persistence files, or logs. Only
  `{ enabled: boolean, provider: 'codex-chatgpt' }` is persisted.
- **No `npx` at runtime.** The adapter is a pinned, exact (no `^`/`~`) version in
  `package.json` with a committed lockfile change.
- **Correct language only.** UI/docs copy: "Uses your ChatGPT Codex allowance. OpenAI
  API billing is disabled." Never "free", "costs nothing", "unlimited", or "does not
  consume usage".
- `npm test`, `npx tsc -b`, and `npm run build` clean before every commit. Tasks that
  touch `electron/` also run `npm run electron:build`.
- Tasks 1–4 build the connection and evidence layers with no UI; the app must keep
  building and all existing tests must keep passing at every commit. The feature has
  no visible surface until Task 5.

## File Structure

| File | Responsibility |
|---|---|
| `collector/src/schema.ts` (modify) | Schema v6: `tool_calls.source_file_rel` — the transcript file a tool call was ingested from, the correlation key for exact dispatch attribution. |
| `collector/src/anomalyIngest.ts` (modify) | Thread `sourceFileRel` through `ingestToolCallsAndAnomalies` into `insertToolCall`. |
| `collector/src/transcriptScan.ts` (modify) | Pass the already-known `relativePath` of the file being scanned into `ingestToolCallsAndAnomalies`. |
| `electron/collectorStore.ts` (modify) | Read `source_file_rel` behind a new `MIN_SCHEMA_VERSION_FOR_TOOL_CALL_SOURCE` gate. |
| `electron/crossEngine/dispatchEvidence.ts` (new) | Resolve a dispatch's project root, claim (on-demand transcript read), and exact touched-file list from its `tool_use_id` alone. |
| `electron/crossEngine/acpProcess.ts` (new) | Resolve pinned adapter path, build the allowlisted child environment, spawn/terminate. |
| `electron/crossEngine/acpClient.ts` (new) | ACP JSON-RPC over stdio: initialize, authenticate, session, prompt, cancel, event routing. |
| `electron/crossEngine/codexSubscriptionPolicy.ts` (new) | Permit only `chat-gpt`; reject everything else, always. |
| `electron/crossEngine/snapshotBuilder.ts` (new) | Build and dispose the isolated verification snapshot. |
| `electron/crossEngine/verificationPrompt.ts` (new) | Build the claim-versus-artifact instructions sent to Codex. |
| `electron/crossEngine/verificationResult.ts` (new) | Validate/clamp the structured result; invalid → `inconclusive`. |
| `electron/crossEngine/codexVerifier.ts` (new) | Orchestrate one run: evidence → snapshot → connect → prompt → result → cleanup. |
| `src/shared/crossEngineTypes.ts` (new) | Provider-neutral status/request/event/result types shared by main and renderer. |
| `electron/preload.ts`, `src/aetherElectron.d.ts` (modify) | `crossEngine.{status,connectCodexSubscription,verifyDispatch,cancel,onUpdate}`. |
| `src/state/types.ts`, `reducer.ts`, `initialState.ts`, `persistence.ts` (modify) | `crossEngineCfg: { enabled, provider }`, in-memory-only run state. |
| `src/components/settings/CrossEngineVerificationCard.tsx` (new) | Default-off toggle, connect/reconnect, test connection, privacy disclosure. |
| `src/components/agents/VerifyWithCodexButton.tsx` (new) | Per-dispatch action, disabled with a named reason when evidence is insufficient. |
| `src/shared/noApiCalls.test.ts` (modify) | Refactor into a guard that permits exactly the reviewed ACP process path and nothing else. |

---

### Task 0: Reconcile the design with shipped reality

**Files:** none changed. Produces a delta note only.
- Create: `docs/superpowers/specs/2026-08-07-codex-acp-reconciliation-note.md`

**Interfaces:** none — this task's output is a written decision that Tasks 1–3 depend on.

The spec's own §15 requires this before any code: confirm dispatch-to-file correlation,
on-demand claim extraction, and project-root resolution against the actual codebase, and
stop if any of them can't be resolved without storing raw payloads. This has already been
researched; this task writes the finding down as the binding decision for later tasks.

- [ ] **Step 1: Write the reconciliation note**

Create `docs/superpowers/specs/2026-08-07-codex-acp-reconciliation-note.md`:

```markdown
# Codex ACP Verification — Reconciliation Note

Written per spec §15 Task 0, before any implementation code.

## 1. Dispatch-to-file correlation

No exact link exists today. `tool_calls` (`collector/src/schema.ts`) has no
`dispatch_id`/`session_id` column, and `tool_calls.tool_use_id` names the
Edit/Write/Read call itself, not the enclosing Task dispatch.

**Root cause, not previously documented:** `scanTranscriptsOnce`
(`collector/src/transcriptScan.ts`) lists only top-level `<sessionId>.jsonl`
files per project directory (`readdirSync(dirPath).filter(f =>
f.endsWith('.jsonl'))`, non-recursive). A dispatch's own tool calls live in a
*separate* file, `<sessionDir>/<sessionId>/subagents/agent-<agentId>.jsonl`
(confirmed in `electron/transcriptReader.ts`'s own on-disk-layout comment,
verified against real transcripts for Stage 14). The collector has never
scanned these files, so today's `tool_calls` rows can only ever be top-level-
session tool calls, never a subagent dispatch's own edits.

**Decision:** two changes, not the `dispatch_tool_use_id`-at-ingest-time
approach the spec sketched:

1. `transcriptScan.ts` must also scan each pinned session's
   `<sessionId>/subagents/*.jsonl` files (extending the existing per-file loop
   to a second pass per session directory, reusing `readNewLinesSync`/
   `getLastOffset`/`recordOffset` unchanged — they're already keyed by
   relative file path, which works identically for a nested path).
2. Schema v6 adds `tool_calls.source_file_rel TEXT` — the relative path of the
   file a tool call was parsed from (already known in `transcriptScan.ts` as
   `relativePath`, just not threaded through `ingestToolCallsAndAnomalies` →
   `insertToolCall` today).

At verification time, `dispatchEvidence.ts` maps a dispatch's `tool_use_id` to
its subagent file exactly the way `transcriptReader.ts`'s
`listTranscriptSources` already does (read the pinned session's
`subagents/*.meta.json` files, match `toolUseId`, get the `.jsonl` basename),
then filters `tool_calls` rows by `source_file_rel` equal to that file's
relative path. This reuses existing, tested path-resolution logic instead of
inventing new ingest-time correlation, and it generalizes correctly: a tool
call whose `source_file_rel` is the top-level session file is (correctly)
never attributable to any dispatch.

## 2. On-demand claim extraction

Confirmed reusable: `electron/transcriptReader.ts`'s `resolveSourcePath` +
`readTranscript` already resolve and read a dispatch's own transcript file
from a `dispatch:<parentSessionId>:<agentFileBase>` source id, and
`toDisplayMessage` already extracts assistant text from a parsed line. No
existing function returns "just the final assistant message", so
`dispatchEvidence.ts` adds a small caller-side loop: read the dispatch's
transcript from the tail, paging backward via `nextBefore` until a
`role: 'assistant'` message with non-null text is found. Never written to
SQLite, matching `transcriptReader.ts`'s own no-persistent-cache header.

## 3. Project-root resolution

No `cwd` column exists in any collector table. `resolveProject`
(`src/shared/projectIdentity.ts`) and `buildProjectsSnapshot`
(`src/shared/projectsSnapshot.ts`) operate on live parsed transcript events,
which do carry `cwd` per line. `dispatchEvidence.ts` resolves a single
dispatch's project root by reading its own transcript file (same file
resolved for claim extraction above), taking `cwd` off any one parsed event
line in it, and feeding that into the existing, unmodified `resolveProject`.

## Conclusion

None of the three requires storing a raw payload. All three resolve through
either a single new narrow column (`source_file_rel`) or reuse of existing,
already-tested resolution code. Proceeding to Task 1.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-08-07-codex-acp-reconciliation-note.md
git commit -m "docs(cross-engine): reconcile Codex ACP spec against shipped collector/transcript code"
```

---

### Task 1: Billing safety tests (write first, must fail)

**Files:**
- Create: `electron/crossEngine/acpProcess.ts`, `electron/crossEngine/acpProcess.test.ts`
- Create: `electron/crossEngine/codexSubscriptionPolicy.ts`, `electron/crossEngine/codexSubscriptionPolicy.test.ts`
- Modify: `src/shared/noApiCalls.test.ts`

**Interfaces:**
- Produces: `buildCodexChildEnv(osEnv: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv`,
  `resolveCodexHome(): string`, `type CodexAuthStatus = 'chat-gpt' | 'api-key' | 'gateway' | 'unauthenticated' | 'unknown'`,
  `isAllowedAuthStatus(status: CodexAuthStatus | null | undefined): status is 'chat-gpt'`.

- [ ] **Step 1: Write the failing environment-isolation test**

```ts
// electron/crossEngine/acpProcess.test.ts
import { describe, it, expect } from 'vitest';
import { buildCodexChildEnv, resolveCodexHome } from './acpProcess';

const BLOCKED = [
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID', 'MODEL_PROVIDER', 'DEFAULT_AUTH_REQUEST', 'CODEX_CONFIG', 'CODEX_PATH',
];
const REQUIRED_SURVIVE = ['PATH', 'TEMP', 'TMP'];

describe('buildCodexChildEnv', () => {
  it('removes every blocked billing/provider variable', () => {
    const osEnv = Object.fromEntries(BLOCKED.map((k) => [k, 'leaked-value'])) as NodeJS.ProcessEnv;
    const child = buildCodexChildEnv(osEnv, 'C:/fake/codex-home');
    for (const key of BLOCKED) expect(child[key]).toBeUndefined();
  });

  it('does not inherit process.env by spreading it first', () => {
    const osEnv = { RANDOM_UNRELATED_VAR: 'x', PATH: '/usr/bin' } as NodeJS.ProcessEnv;
    const child = buildCodexChildEnv(osEnv, 'C:/fake/codex-home');
    expect(child.RANDOM_UNRELATED_VAR).toBeUndefined();
  });

  it('preserves required OS variables the adapter needs to run', () => {
    const osEnv = { PATH: '/usr/bin', TEMP: '/tmp', TMP: '/tmp' } as NodeJS.ProcessEnv;
    const child = buildCodexChildEnv(osEnv, 'C:/fake/codex-home');
    for (const key of REQUIRED_SURVIVE) expect(child[key]).toBe((osEnv as Record<string, string>)[key]);
  });

  it('always sets CODEX_HOME to the dedicated directory, never the OS value', () => {
    const osEnv = { CODEX_HOME: '/some/other/global/home' } as NodeJS.ProcessEnv;
    const child = buildCodexChildEnv(osEnv, 'C:/fake/codex-home');
    expect(child.CODEX_HOME).toBe('C:/fake/codex-home');
  });
});

describe('resolveCodexHome', () => {
  it('returns a path under ~/.aether-os/codex-home', () => {
    expect(resolveCodexHome().replace(/\\/g, '/')).toMatch(/\.aether-os\/codex-home$/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run electron/crossEngine/acpProcess.test.ts`
Expected: FAIL — cannot resolve `./acpProcess`.

- [ ] **Step 3: Write the failing auth-policy test**

```ts
// electron/crossEngine/codexSubscriptionPolicy.test.ts
import { describe, it, expect } from 'vitest';
import { isAllowedAuthStatus } from './codexSubscriptionPolicy';

describe('isAllowedAuthStatus', () => {
  it('permits only chat-gpt', () => {
    expect(isAllowedAuthStatus('chat-gpt')).toBe(true);
  });

  it('blocks api-key, gateway, unauthenticated, unknown, null, and undefined', () => {
    expect(isAllowedAuthStatus('api-key')).toBe(false);
    expect(isAllowedAuthStatus('gateway')).toBe(false);
    expect(isAllowedAuthStatus('unauthenticated')).toBe(false);
    expect(isAllowedAuthStatus('unknown')).toBe(false);
    expect(isAllowedAuthStatus(null)).toBe(false);
    expect(isAllowedAuthStatus(undefined)).toBe(false);
  });

  it('blocks any string not exactly "chat-gpt", including near-misses', () => {
    expect(isAllowedAuthStatus('chat-gpt ' as never)).toBe(false);
    expect(isAllowedAuthStatus('ChatGPT' as never)).toBe(false);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run electron/crossEngine/codexSubscriptionPolicy.test.ts`
Expected: FAIL — cannot resolve `./codexSubscriptionPolicy`.

- [ ] **Step 5: Write the failing capability-guard test additions**

Append to `src/shared/noApiCalls.test.ts` (read the existing file first — these
tests extend its existing pattern, they do not replace its current assertions):

```ts
describe('cross-engine Codex boundary', () => {
  it('the general OpenAI API SDK is not a dependency', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
    expect(pkg.dependencies?.openai).toBeUndefined();
    expect(pkg.devDependencies?.openai).toBeUndefined();
  });

  it('no source file calls the OpenAI or Anthropic HTTP APIs directly', () => {
    const hits = grepSourceFor(/api\.openai\.com|api\.anthropic\.com/);
    expect(hits).toEqual([]);
  });

  it('only the reviewed ACP process module references the Codex adapter executable', () => {
    const hits = grepSourceFor(/codex-acp/).filter(
      (f) => !f.includes('electron/crossEngine/acpProcess.ts') && !f.includes('.test.ts') && !f.includes('docs/')
    );
    expect(hits).toEqual([]);
  });
});
```

(If `grepSourceFor`/`readFileSync`/`resolve` helpers don't already exist in this
file, add a minimal synchronous directory-walk helper reading `.ts`/`.tsx` files
under `src/` and `electron/`, excluding `node_modules`/`dist`.)

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run src/shared/noApiCalls.test.ts`
Expected: FAIL — `codex-acp` doesn't exist anywhere yet, so the "only reviewed
module references it" test trivially passes, but the OpenAI-dependency test
needs `readFileSync`/`resolve` wired if not already present; confirm compile
failure or pass, not a false green from unwritten assertions.

- [ ] **Step 7: Commit the failing tests**

```bash
git add electron/crossEngine/acpProcess.test.ts electron/crossEngine/codexSubscriptionPolicy.test.ts src/shared/noApiCalls.test.ts
git commit -m "test(cross-engine): define subscription-only Codex billing boundary"
```

---

### Task 2: Pinned ACP process, environment builder, and auth probe

**Files:**
- Create: `electron/crossEngine/acpProcess.ts` (impl), `electron/crossEngine/acpClient.ts`, `electron/crossEngine/acpClient.test.ts`
- Create: `electron/crossEngine/codexSubscriptionPolicy.ts` (impl)
- Create: `src/shared/crossEngineTypes.ts`
- Modify: `package.json`, `package-lock.json`

**Interfaces:**
- Consumes: `buildCodexChildEnv`, `resolveCodexHome`, `isAllowedAuthStatus` (Task 1, now implemented here).
- Produces: `spawnAcpProcess(): ChildProcessWithoutNullStreams`, `class AcpClient` with
  `initialize()`, `authenticate()`, `authenticationStatus(): Promise<CodexAuthStatus>`,
  `probe(): Promise<VerifierStatus>`, `dispose(): Promise<void>`; type `VerifierStatus =
  'disabled' | 'not-installed' | 'sign-in-required' | 'ready-subscription' |
  'blocked-billing-mode' | 'version-unsupported' | 'error'` in `crossEngineTypes.ts`.

- [ ] **Step 1: Pin the adapter dependency**

Check the current published version of `@agentclientprotocol/codex-acp` and its
declared `@agentclientprotocol/sdk` peer version. Add both as exact-pinned
dependencies (no `^`/`~`) to `package.json`:

```json
"dependencies": {
  "@agentclientprotocol/codex-acp": "1.1.14",
  "@agentclientprotocol/sdk": "1.3.0"
}
```

Run `npm install` to update the lockfile. Record the exact versions used in a
comment above the dependency block: `// Pinned per docs/superpowers/specs/2026-08-07-codex-acp-subscription-verification.md §1 — recheck at each bump, never npx.`

- [ ] **Step 2: Implement the environment builder and process spawn**

```ts
// electron/crossEngine/acpProcess.ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const REQUIRED_OS_VARS = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
];

/** Dedicated Codex home: isolates Aether from any globally configured
 *  OpenAI API-key login, custom model providers, or unrelated MCP servers. */
export function resolveCodexHome(): string {
  return join(homedir(), '.aether-os', 'codex-home');
}

/** Never starts from process.env and removes keys -- builds an allowlist
 *  from nothing, so a newly invented billing-bypass env var is excluded by
 *  default rather than requiring this function to be updated to block it. */
export function buildCodexChildEnv(osEnv: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const key of REQUIRED_OS_VARS) {
    if (osEnv[key] !== undefined) child[key] = osEnv[key];
  }
  child.CODEX_HOME = codexHome;
  return child;
}

let adapterExecutablePath: string | null = null;

/** Resolves the pinned local package's binary. Never npx -- see Global Constraints. */
function resolveAdapterExecutable(): string {
  if (adapterExecutablePath) return adapterExecutablePath;
  adapterExecutablePath = require.resolve('@agentclientprotocol/codex-acp/bin/codex-acp');
  return adapterExecutablePath;
}

const MAX_RETAINED_STDERR_BYTES = 8192;

export function spawnAcpProcess(): ChildProcessWithoutNullStreams {
  const codexHome = resolveCodexHome();
  const env = buildCodexChildEnv(process.env, codexHome);
  const executable = resolveAdapterExecutable();
  const child = spawn(executable, [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env });

  let stderrBuf = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-MAX_RETAINED_STDERR_BYTES);
  });
  (child as ChildProcessWithoutNullStreams & { retainedStderr: () => string }).retainedStderr = () => stderrBuf;

  return child;
}
```

(Adjust `require.resolve` path to whatever the pinned package actually exports
once installed — verify with `node -e "console.log(require.resolve('@agentclientprotocol/codex-acp/bin/codex-acp'))"`
and correct the subpath if different.)

- [ ] **Step 3: Implement the subscription policy guard**

```ts
// electron/crossEngine/codexSubscriptionPolicy.ts
import type { CodexAuthStatus } from '../../src/shared/crossEngineTypes';

/** The only allowed status. Everything else -- including a value this
 *  union doesn't even name yet -- fails closed by construction: the
 *  comparison is a literal equality check, not a blocklist membership
 *  test, so a new unrecognized status can never accidentally pass. */
export function isAllowedAuthStatus(status: CodexAuthStatus | string | null | undefined): status is 'chat-gpt' {
  return status === 'chat-gpt';
}
```

- [ ] **Step 4: Add the shared types**

```ts
// src/shared/crossEngineTypes.ts
export type CodexAuthStatus = 'chat-gpt' | 'api-key' | 'gateway' | 'unauthenticated' | 'unknown';

export type VerifierStatus =
  | 'disabled' | 'not-installed' | 'sign-in-required' | 'ready-subscription'
  | 'blocked-billing-mode' | 'version-unsupported' | 'error';

export type VerdictKind = 'supported' | 'contradicted' | 'inconclusive';

export interface VerificationFinding {
  severity: 'info' | 'warning' | 'error';
  claim: string;
  evidence: string;
  file: string | null;
  line: number | null;
}

export interface VerificationTest {
  command: string;
  outcome: 'passed' | 'failed' | 'not-run';
  detail: string;
}

export interface VerificationResultV1 {
  schemaVersion: 1;
  verdict: VerdictKind;
  confidence: number;
  summary: string;
  findings: VerificationFinding[];
  tests: VerificationTest[];
  limitations: string[];
}

export interface VerificationRequest {
  toolUseId: string;
}

export type VerificationEvent =
  | { kind: 'status'; runId: string; phase: 'preparing-evidence' | 'creating-snapshot' | 'checking-auth' | 'verifying' | 'running-tests' }
  | { kind: 'result'; runId: string; result: VerificationResultV1 }
  | { kind: 'error'; runId: string; code: string; message: string }
  | { kind: 'cancelled'; runId: string };
```

- [ ] **Step 5: Implement `AcpClient` with a fake-process integration test**

```ts
// electron/crossEngine/acpClient.ts
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnAcpProcess } from './acpProcess';
import { isAllowedAuthStatus } from './codexSubscriptionPolicy';
import type { CodexAuthStatus, VerifierStatus } from '../../src/shared/crossEngineTypes';

interface JsonRpcRequest { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
interface JsonRpcResponse { jsonrpc: '2.0'; id: number; result?: unknown; error?: { code: number; message: string } }

/** JSON-RPC over stdio. One line per message, newline-delimited -- the ACP
 *  wire format. Pending requests are tracked by id so responses can arrive
 *  out of order relative to other event traffic on the same stream. */
export class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';

  connect(child: ChildProcessWithoutNullStreams = spawnAcpProcess()): void {
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // malformed line -- never crash the client on it
      }
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    }
  }

  private call(method: string, params?: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP call "${method}" timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child!.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  async initialize(): Promise<void> {
    await this.call('initialize', {});
  }

  /** Only ever sends methodId: 'chat-gpt' -- api-key/gateway methods the
   *  adapter advertises are never selected, even if offered. */
  async authenticate(): Promise<void> {
    await this.call('authenticate', { methodId: 'chat-gpt' });
  }

  async authenticationStatus(): Promise<CodexAuthStatus> {
    try {
      const result = (await this.call('authentication/status')) as { type?: string };
      const type = result?.type;
      if (type === 'chat-gpt' || type === 'api-key' || type === 'gateway' || type === 'unauthenticated') return type;
      return 'unknown';
    } catch {
      return 'unknown'; // any failure to prove status is treated as unknown -- fails closed downstream
    }
  }

  async probe(): Promise<VerifierStatus> {
    try {
      await this.initialize();
      const status = await this.authenticationStatus();
      if (status === 'unauthenticated') return 'sign-in-required';
      if (isAllowedAuthStatus(status)) return 'ready-subscription';
      return 'blocked-billing-mode';
    } catch {
      return 'error';
    }
  }

  async dispose(): Promise<void> {
    for (const [, p] of this.pending) p.reject(new Error('client disposed'));
    this.pending.clear();
    if (this.child) {
      this.child.stdin.end();
      this.child.kill();
      this.child = null;
    }
  }
}
```

```ts
// electron/crossEngine/acpClient.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AcpClient } from './acpClient';

function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const emitter = new EventEmitter() as unknown as { stdout: typeof stdout; stdin: typeof stdin; kill: () => void };
  emitter.stdout = stdout;
  emitter.stdin = stdin;
  emitter.kill = vi.fn();
  return emitter;
}

function respondTo(child: ReturnType<typeof fakeChild>, result: unknown) {
  child.stdin.once('data', (data: Buffer) => {
    const req = JSON.parse(data.toString('utf8'));
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
  });
}

describe('AcpClient.probe', () => {
  it('returns ready-subscription when auth status is chat-gpt', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, {}); // initialize
    respondTo(child, { type: 'chat-gpt' }); // authentication/status
    expect(await client.probe()).toBe('ready-subscription');
  });

  it('returns sign-in-required when unauthenticated', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, {});
    respondTo(child, { type: 'unauthenticated' });
    expect(await client.probe()).toBe('sign-in-required');
  });

  it('returns blocked-billing-mode for api-key status', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, {});
    respondTo(child, { type: 'api-key' });
    expect(await client.probe()).toBe('blocked-billing-mode');
  });

  it('returns blocked-billing-mode for gateway status', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, {});
    respondTo(child, { type: 'gateway' });
    expect(await client.probe()).toBe('blocked-billing-mode');
  });

  it('treats a malformed status reply as unknown, which blocks', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    respondTo(child, {});
    child.stdin.once('data', (data: Buffer) => {
      const req = JSON.parse(data.toString('utf8'));
      child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { type: 'something-new' } }) + '\n');
    });
    expect(await client.probe()).toBe('blocked-billing-mode');
  });

  it('returns error status when initialize itself fails', async () => {
    const child = fakeChild();
    const client = new AcpClient();
    client.connect(child as never);
    child.stdin.once('data', (data: Buffer) => {
      const req = JSON.parse(data.toString('utf8'));
      child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -1, message: 'boom' } }) + '\n');
    });
    expect(await client.probe()).toBe('error');
  });
});
```

- [ ] **Step 6: Run all Task 1+2 tests to verify pass**

Run: `npx vitest run electron/crossEngine/`
Expected: PASS, all tests green including the Task 1 tests now that implementations exist.

- [ ] **Step 7: Verify and commit**

Run: `npx tsc -b` (expect exit 0).

```bash
git add package.json package-lock.json electron/crossEngine/acpProcess.ts electron/crossEngine/acpClient.ts electron/crossEngine/acpClient.test.ts electron/crossEngine/codexSubscriptionPolicy.ts src/shared/crossEngineTypes.ts
git commit -m "feat(cross-engine): add subscription-only Codex ACP connection"
```

---

### Task 3: Evidence resolution and snapshot isolation

**Files:**
- Modify: `collector/src/schema.ts`, `collector/src/anomalyIngest.ts`, `collector/src/anomalyIngest.test.ts`, `collector/src/transcriptScan.ts`, `collector/src/transcriptScan.test.ts`
- Modify: `electron/collectorStore.ts`
- Create: `electron/crossEngine/dispatchEvidence.ts`, `electron/crossEngine/dispatchEvidence.test.ts`
- Create: `electron/crossEngine/snapshotBuilder.ts`, `electron/crossEngine/snapshotBuilder.test.ts`

**Interfaces:**
- Consumes: `resolveProject`, `type GitProbe` (`src/shared/projectIdentity.ts`, unmodified);
  `resolveSourcePath`, `readTranscript`, `listTranscriptSources` (`electron/transcriptReader.ts`, unmodified).
- Produces: `resolveDispatchEvidence(toolUseId: string, db: DatabaseSync, sessionDir: string): Promise<DispatchEvidence | { missing: string }>`
  where `DispatchEvidence = { toolUseId: string; projectRoot: string; claim: string; touchedFiles: string[] }`;
  `buildVerificationSnapshot(evidence: DispatchEvidence): Promise<{ snapshotDir: string; dispose: () => Promise<void> }>`.

- [ ] **Step 1: Schema v6 — add `source_file_rel`**

In `collector/src/schema.ts`, bump `SCHEMA_VERSION` to `6` and add the migration
per the file's existing v5 pattern:

```ts
export const SCHEMA_VERSION = 6;
```

```ts
  // v6 migration: add the source-file correlation column. Populated going
  // forward only -- rows ingested under schema < 6 keep source_file_rel NULL,
  // which readers must treat as "predates exact correlation", not "not part
  // of a dispatch". See docs/superpowers/specs/2026-08-07-codex-acp-reconciliation-note.md.
  if (currentVersion < 6) {
    db.exec(`ALTER TABLE tool_calls ADD COLUMN source_file_rel TEXT;`);
  }
```

- [ ] **Step 2: Thread `sourceFileRel` through ingest**

In `collector/src/anomalyIngest.ts`, change `ingestToolCallsAndAnomalies`'s
signature to accept the source file's relative path, and pass it through to
the insert:

```ts
export function ingestToolCallsAndAnomalies(
  db: DatabaseSync,
  history: ToolCallHistory,
  events: ParsedTranscriptEvent[],
  nowMs: number,
  sourceFileRel: string
): { history: ToolCallHistory; toolCallsIngested: number; anomaliesIngested: number } {
  // ...
  const insertToolCall = db.prepare(
    `INSERT INTO tool_calls (tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms, source_file_rel)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  // ...
  insertToolCall.run(call.toolUseId, call.toolName, call.filePath, call.startedAt, call.closedAt, sourceFileRel);
```

(Read the surrounding function first — this replaces the existing 5-column
`insertToolCall` prepare/run pair with the 6-column version above, keeping
every other line of the function unchanged.)

- [ ] **Step 3: Write the failing test for the threaded parameter**

Add to `collector/src/anomalyIngest.test.ts` (read the file's existing test
setup first and match its fixture style):

```ts
it('records the source file a tool call was parsed from', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  const events = [/* one closed Edit tool call, matching an existing fixture in this file */];
  ingestToolCallsAndAnomalies(db, createEmptyHistory(), events, 2000, 'proj/session-id/subagents/agent-abc.jsonl');
  const row = db.prepare('SELECT source_file_rel FROM tool_calls LIMIT 1').get() as { source_file_rel: string };
  expect(row.source_file_rel).toBe('proj/session-id/subagents/agent-abc.jsonl');
});
```

- [ ] **Step 4: Run to verify failure, then pass**

Run: `npx vitest run collector/src/anomalyIngest.test.ts`
Expected: FAIL before Step 2/3's implementation change is complete (wrong
arity), PASS after.

- [ ] **Step 5: Scan subagent transcript files too**

In `collector/src/transcriptScan.ts`, after the existing per-session-file loop
body resolves `parsedEvents` and calls `ingestToolCallsAndAnomalies` for the
top-level file, pass `relativePath` as the new fifth argument:

```ts
      const anomalyResult = ingestToolCallsAndAnomalies(db, priorHistory, parsedEvents, nowMs, relativePath);
```

Then add a second pass, once per session file already found in this loop,
that also lists and scans that session's `subagents/*.jsonl` files the same
way `readdirSync`+`readNewLinesSync`+`recordOffset` already handle top-level
files — reusing every one of those functions unchanged, since they're keyed
by relative path and don't care whether that path has a nested directory
component:

```ts
      // Subagent dispatch transcripts (Stage-5-era gap, closed here): each
      // dispatch's own tool calls live in a separate file this loop
      // otherwise never visits. See the reconciliation note §1.
      const sessionBase = file.replace(/\.jsonl$/, '');
      const subagentsDir = join(dirPath, sessionBase, 'subagents');
      let subagentFiles: string[];
      try {
        subagentFiles = readdirSync(subagentsDir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        subagentFiles = [];
      }
      for (const subFile of subagentFiles) {
        const subFilePath = join(subagentsDir, subFile);
        const subRelativePath = join(dirName, sessionBase, 'subagents', subFile);
        const subOffset = getLastOffset(db, subRelativePath);
        let subLines: string[];
        let subNewOffset: number;
        try {
          const subResult = readNewLinesSync(subFilePath, subOffset);
          subLines = subResult.lines;
          subNewOffset = subResult.newOffset;
        } catch {
          continue;
        }
        const subParsedEvents = subLines.map((l) => parseTranscriptLine(l)).filter((e): e is NonNullable<typeof e> => e !== null);
        const subPriorHistory = historyByFile.get(subRelativePath) ?? createEmptyHistory();
        const subAnomalyResult = ingestToolCallsAndAnomalies(db, subPriorHistory, subParsedEvents, nowMs, subRelativePath);
        historyByFile.set(subRelativePath, subAnomalyResult.history);
        toolCallsIngested += subAnomalyResult.toolCallsIngested;
        anomaliesIngested += subAnomalyResult.anomaliesIngested;
        recordOffset(db, subRelativePath, subNewOffset, nowMs);
      }
```

(Place this after the existing top-level `recordOffset(db, relativePath, newOffset, nowMs)` call for the session file, inside the same `for (const file of files)` loop.)

- [ ] **Step 6: Write the failing test for subagent scanning**

Add to `collector/src/transcriptScan.test.ts` (match the file's existing
temp-directory fixture pattern): create a fake `<sessionId>.jsonl` plus a
`<sessionId>/subagents/agent-x.jsonl` under a temp `projectsRoot`, run
`scanTranscriptsOnce`, and assert `toolCallsIngested` counts tool calls from
*both* files, and that querying `tool_calls` for `source_file_rel` matching
the subagent path returns the subagent's own rows.

- [ ] **Step 7: Run to verify failure, then pass**

Run: `npx vitest run collector/src/transcriptScan.test.ts`
Expected: FAIL before the Step 5 change, PASS after.

- [ ] **Step 8: Read `source_file_rel` in `electron/collectorStore.ts`**

Add `MIN_SCHEMA_VERSION_FOR_TOOL_CALL_SOURCE = 6` beside the existing
constants, and extend the `tool_calls` SELECT (only when `version >= 6`) to
include `source_file_rel`, threading it into `DiagnosticsSnapshot.toolCalls`'
mapped shape as `sourceFileRel: string | null` (null both when the row
predates schema 6 and when the column value itself is NULL — same
"not available" collapse the file already uses for pre-v5 dispatch columns).

- [ ] **Step 9: Write and run the collectorStore test for the new field**

Add a test mirroring the existing `MIN_SCHEMA_VERSION_FOR_DISPATCH_TELEMETRY`
gating tests in `electron/collectorStore.test.ts`: a v6 database returns
`sourceFileRel`, a v5 database returns `null` for every row without erroring.

Run: `npx vitest run electron/collectorStore.test.ts`
Expected: PASS.

- [ ] **Step 10: Implement dispatch evidence resolution**

```ts
// electron/crossEngine/dispatchEvidence.ts
import type { DatabaseSync } from 'node:sqlite';
import { resolveSourcePath, readTranscript, listTranscriptSources } from '../transcriptReader';
import { resolveProject, type GitProbe } from '../../src/shared/projectIdentity';

export interface DispatchEvidence {
  toolUseId: string;
  projectRoot: string;
  claim: string;
  touchedFiles: string[];
}

export type EvidenceResult = { ok: true; evidence: DispatchEvidence } | { ok: false; missing: string };

/** Finds the dispatch's own transcript source id by matching toolUseId
 *  against each subagent's meta.json -- the same lookup
 *  transcriptReader.listTranscriptSources already performs for the Comms
 *  Deck, reused here rather than re-implemented. */
async function findDispatchSourceId(sessionDir: string, pinnedSessionId: string, toolUseId: string): Promise<string | null> {
  const sources = await listTranscriptSources(sessionDir, pinnedSessionId);
  const match = sources.find((s) => s.kind === 'dispatch' && s.toolUseId === toolUseId);
  return match?.id ?? null;
}

/** Pages backward from the tail of the dispatch's transcript until it finds
 *  a non-empty assistant message -- readTranscript has no "last assistant
 *  message only" mode, so this is the smallest correct wrapper. */
async function extractFinalClaim(filePath: string): Promise<string | null> {
  let cursor: number | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await readTranscript(filePath, { limit: 50, before: cursor });
    for (let i = result.messages.length - 1; i >= 0; i -= 1) {
      const msg = result.messages[i];
      if (msg.role === 'assistant' && msg.text) return msg.text;
    }
    if (!result.hasMore) break;
    cursor = result.nextBefore;
  }
  return null;
}

export async function resolveDispatchEvidence(
  toolUseId: string,
  db: DatabaseSync,
  sessionDir: string,
  pinnedSessionId: string,
  gitProbe: GitProbe
): Promise<EvidenceResult> {
  const sourceId = await findDispatchSourceId(sessionDir, pinnedSessionId, toolUseId);
  if (!sourceId) return { ok: false, missing: 'dispatch transcript not found' };

  const filePath = resolveSourcePath(sessionDir, sourceId);
  const claim = await extractFinalClaim(filePath);
  if (!claim) return { ok: false, missing: 'no final assistant message found for this dispatch' };

  // The dispatch's own transcript file, addressed dispatch:<parentId>:<agentBase>,
  // resolves to a relative path of "<parentId>/subagents/<agentBase>.jsonl" once
  // the sessionDir prefix and path separators are normalized -- this must match
  // exactly what transcriptScan.ts recorded as source_file_rel.
  const sourceFileRel = sourceId.replace(/^dispatch:/, '').split(':').join('/subagents/') + '.jsonl';
  const touchedRows = db
    .prepare('SELECT DISTINCT file_path_rel FROM tool_calls WHERE source_file_rel = ? AND file_path_rel IS NOT NULL')
    .all(sourceFileRel) as { file_path_rel: string }[];
  const touchedFiles = touchedRows.map((r) => r.file_path_rel);
  if (touchedFiles.length === 0) return { ok: false, missing: 'no exact file-touch correlation available for this dispatch' };

  const result = await readTranscript(filePath, { limit: 1 });
  const cwd = result.messages[0]?.cwd ?? null;
  if (!cwd) return { ok: false, missing: 'dispatch project root could not be resolved' };
  const ref = resolveProject(cwd, gitProbe);
  if (!ref) return { ok: false, missing: 'dispatch project root could not be resolved' };

  return { ok: true, evidence: { toolUseId, projectRoot: ref.repoPath, claim, touchedFiles } };
}
```

(Verify `TranscriptReadResult`'s exact message/pagination field names —
`hasMore`/`nextBefore`/`role`/`text`/`cwd` — against `electron/transcriptReader.ts`'s
actual `DisplayMessage`/`TranscriptReadResult` interfaces before finalizing; adjust
field names in this file to match exactly rather than guessing.)

- [ ] **Step 11: Write the failing evidence-resolution tests**

```ts
// electron/crossEngine/dispatchEvidence.test.ts
import { describe, it, expect } from 'vitest';
import { resolveDispatchEvidence } from './dispatchEvidence';
// Set up a fake sessionDir with a session file, one subagents/agent-x.jsonl +
// agent-x.meta.json (toolUseId matching), and a fake db with a matching
// tool_calls row keyed on source_file_rel, following this repo's existing
// transcriptReader.test.ts fixture style for temp directories.

describe('resolveDispatchEvidence', () => {
  it('resolves claim, project root, and touched files for a known dispatch', async () => { /* ... */ });
  it('returns missing when the dispatch transcript cannot be found', async () => { /* ... */ });
  it('returns missing when no final assistant message exists', async () => { /* ... */ });
  it('returns missing when no exact file-touch correlation exists for this dispatch', async () => { /* ... */ });
  it('returns missing when project root cannot be resolved', async () => { /* ... */ });
});
```

- [ ] **Step 12: Run to verify failure, then pass**

Run: `npx vitest run electron/crossEngine/dispatchEvidence.test.ts`
Expected: FAIL, then PASS once Step 10 compiles against the real
`transcriptReader.ts` types.

- [ ] **Step 13: Implement the isolated snapshot builder**

```ts
// electron/crossEngine/snapshotBuilder.ts
import { mkdtemp, rm, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative, resolve as resolvePath, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DispatchEvidence } from './dispatchEvidence';

const execFileAsync = promisify(execFile);

export interface VerificationSnapshot {
  snapshotDir: string;
  dispose: () => Promise<void>;
}

/** Rejects any touched path that escapes the project root after
 *  normalization -- the untrusted input here is file_path_rel from SQLite,
 *  which this repo's own privacy conventions already require to be
 *  project-relative, but this is re-verified rather than trusted. */
function assertContained(projectRoot: string, relPath: string): string {
  const abs = resolvePath(projectRoot, relPath);
  const rootWithSep = resolvePath(projectRoot) + sep;
  if (abs !== resolvePath(projectRoot) && !abs.startsWith(rootWithSep)) {
    throw new Error(`touched path escapes project root: ${relPath}`);
  }
  return abs;
}

export async function buildVerificationSnapshot(evidence: DispatchEvidence): Promise<VerificationSnapshot> {
  const snapshotDir = await mkdtemp(join(tmpdir(), 'aether-codex-verify-'));

  try {
    // Committed baseline first (git archive HEAD is insufficient alone --
    // it omits uncommitted work, so it's combined with an explicit copy of
    // the exact approved touched paths below).
    await execFileAsync('git', ['archive', 'HEAD', '-o', join(snapshotDir, '__baseline.tar')], { cwd: evidence.projectRoot });
    await execFileAsync('tar', ['-xf', join(snapshotDir, '__baseline.tar'), '-C', snapshotDir]);
    await rm(join(snapshotDir, '__baseline.tar'));

    for (const relPath of evidence.touchedFiles) {
      const srcAbs = assertContained(evidence.projectRoot, relPath);
      const destAbs = assertContained(snapshotDir, relPath);
      await mkdir(dirname(destAbs), { recursive: true });
      try {
        await copyFile(srcAbs, destAbs);
      } catch {
        // File deleted since the dispatch touched it: represent the
        // deletion by removing it from the snapshot if the baseline had it.
        await rm(destAbs, { force: true });
      }
    }
  } catch (err) {
    await rm(snapshotDir, { recursive: true, force: true });
    throw err;
  }

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await rm(snapshotDir, { recursive: true, force: true });
  };

  return { snapshotDir, dispose };
}
```

- [ ] **Step 14: Write the failing snapshot-builder tests**

```ts
// electron/crossEngine/snapshotBuilder.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { buildVerificationSnapshot } from './snapshotBuilder';
// Use a small real temp git repo (git init, one commit, one uncommitted edit)
// as the fixture, following this project's existing git-fixture test style
// if one exists (check electron/*.test.ts for a precedent before inventing one).

describe('buildVerificationSnapshot', () => {
  it('includes the committed baseline plus the current touched-file content', async () => { /* ... */ });
  it('includes touched untracked files not covered by git archive', async () => { /* ... */ });
  it('represents a deleted touched file as absent from the snapshot', async () => { /* ... */ });
  it('rejects a touched path that escapes the project root', async () => { /* ... */ });
  it('dispose removes the snapshot directory and is idempotent', async () => { /* ... */ });
});
```

- [ ] **Step 15: Run to verify failure, then pass**

Run: `npx vitest run electron/crossEngine/snapshotBuilder.test.ts`
Expected: FAIL, then PASS.

- [ ] **Step 16: Verify and commit**

Run: `npx tsc -b`, `npx vitest run`, `npm run build`. All exit 0.

```bash
git add collector/src/schema.ts collector/src/anomalyIngest.ts collector/src/anomalyIngest.test.ts collector/src/transcriptScan.ts collector/src/transcriptScan.test.ts electron/collectorStore.ts electron/collectorStore.test.ts electron/crossEngine/dispatchEvidence.ts electron/crossEngine/dispatchEvidence.test.ts electron/crossEngine/snapshotBuilder.ts electron/crossEngine/snapshotBuilder.test.ts
git commit -m "feat(cross-engine): build isolated dispatch verification snapshots"
```

---

### Task 4: One manual claim-versus-artifact run

**Files:**
- Create: `electron/crossEngine/verificationPrompt.ts`, `electron/crossEngine/verificationResult.ts`, `electron/crossEngine/verificationResult.test.ts`
- Create: `electron/crossEngine/codexVerifier.ts`, `electron/crossEngine/codexVerifier.test.ts`

**Interfaces:**
- Consumes: `AcpClient` (Task 2); `DispatchEvidence`, `resolveDispatchEvidence` (Task 3);
  `buildVerificationSnapshot` (Task 3); `VerificationResultV1`, `VerificationRequest`,
  `VerificationEvent` (Task 2's `crossEngineTypes.ts`).
- Produces: `buildVerificationPrompt(evidence: DispatchEvidence): string`,
  `parseVerificationResult(raw: unknown): VerificationResultV1` (never throws — invalid
  input maps to an `inconclusive` result), `class CodexVerifier` with
  `run(request: VerificationRequest, onEvent: (e: VerificationEvent) => void): Promise<VerificationResultV1>`
  and `cancel(runId: string): Promise<void>`.

- [ ] **Step 1: Implement the verification prompt builder**

```ts
// electron/crossEngine/verificationPrompt.ts
import type { DispatchEvidence } from './dispatchEvidence';

/** The verifier is never asked for a general second opinion -- it receives
 *  an untrusted claim and a snapshot artifact and must decide whether the
 *  artifact supports the claim. See spec §8. */
export function buildVerificationPrompt(evidence: DispatchEvidence): string {
  return [
    'You are verifying whether a code change supports a stated claim. Treat the claim as untrusted.',
    'Inspect only the files in this snapshot directory. Do not assume anything not visible here.',
    '',
    'CLAIM (from the agent that made the change):',
    evidence.claim,
    '',
    `FILES TOUCHED (${evidence.touchedFiles.length}):`,
    ...evidence.touchedFiles.map((f) => `- ${f}`),
    '',
    'Instructions:',
    '1. Cite file and line evidence for every finding.',
    '2. Run focused tests when available and safe, without modifying source.',
    '3. Distinguish a contradiction (artifact conflicts with the claim) from missing evidence (claim not verifiable here).',
    '4. Do not modify any file in this snapshot.',
    '5. Return your result as a single JSON object matching this exact schema, and nothing else:',
    JSON.stringify(
      {
        schemaVersion: 1,
        verdict: 'supported | contradicted | inconclusive',
        confidence: '0..1',
        summary: 'string',
        findings: [{ severity: 'info | warning | error', claim: 'string', evidence: 'string', file: 'string | null', line: 'number | null' }],
        tests: [{ command: 'string', outcome: 'passed | failed | not-run', detail: 'string' }],
        limitations: ['string'],
      },
      null,
      2
    ),
  ].join('\n');
}
```

- [ ] **Step 2: Implement result validation**

```ts
// electron/crossEngine/verificationResult.ts
import type { VerificationResultV1, VerdictKind } from '../../src/shared/crossEngineTypes';

const VALID_VERDICTS: VerdictKind[] = ['supported', 'contradicted', 'inconclusive'];

function inconclusive(summary: string): VerificationResultV1 {
  return { schemaVersion: 1, verdict: 'inconclusive', confidence: 0, summary, findings: [], tests: [], limitations: [summary] };
}

/** Never throws. Invalid or incomplete structured output becomes
 *  inconclusive rather than a successful verification via optimistic
 *  parsing -- see spec §8's explicit requirement. */
export function parseVerificationResult(raw: unknown): VerificationResultV1 {
  if (typeof raw !== 'object' || raw === null) return inconclusive('Codex returned a non-object result.');
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== 1) return inconclusive('Codex result had an unrecognized schema version.');
  if (typeof obj.verdict !== 'string' || !VALID_VERDICTS.includes(obj.verdict as VerdictKind)) {
    return inconclusive('Codex result had an invalid or missing verdict.');
  }
  const confidence = typeof obj.confidence === 'number' ? Math.min(1, Math.max(0, obj.confidence)) : 0;
  const summary = typeof obj.summary === 'string' ? obj.summary : '';
  const findings = Array.isArray(obj.findings)
    ? obj.findings
        .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
        .map((f) => ({
          severity: f.severity === 'warning' || f.severity === 'error' ? f.severity : ('info' as const),
          claim: typeof f.claim === 'string' ? f.claim : '',
          evidence: typeof f.evidence === 'string' ? f.evidence : '',
          file: typeof f.file === 'string' ? f.file : null,
          line: typeof f.line === 'number' ? f.line : null,
        }))
    : [];
  const tests = Array.isArray(obj.tests)
    ? obj.tests
        .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
        .map((t) => ({
          command: typeof t.command === 'string' ? t.command : '',
          outcome: t.outcome === 'passed' || t.outcome === 'failed' ? t.outcome : ('not-run' as const),
          detail: typeof t.detail === 'string' ? t.detail : '',
        }))
    : [];
  const limitations = Array.isArray(obj.limitations) ? obj.limitations.filter((l): l is string => typeof l === 'string') : [];

  return { schemaVersion: 1, verdict: obj.verdict as VerdictKind, confidence, summary, findings, tests, limitations };
}
```

- [ ] **Step 3: Write the failing result-validation tests**

```ts
// electron/crossEngine/verificationResult.test.ts
import { describe, it, expect } from 'vitest';
import { parseVerificationResult } from './verificationResult';

describe('parseVerificationResult', () => {
  it('parses a well-formed result unchanged', () => {
    const raw = { schemaVersion: 1, verdict: 'supported', confidence: 0.9, summary: 'ok', findings: [], tests: [], limitations: [] };
    expect(parseVerificationResult(raw)).toEqual(raw);
  });
  it('clamps confidence into 0..1', () => {
    expect(parseVerificationResult({ schemaVersion: 1, verdict: 'supported', confidence: 5, summary: '', findings: [], tests: [], limitations: [] }).confidence).toBe(1);
    expect(parseVerificationResult({ schemaVersion: 1, verdict: 'supported', confidence: -5, summary: '', findings: [], tests: [], limitations: [] }).confidence).toBe(0);
  });
  it('returns inconclusive for null, non-object, or missing schemaVersion', () => {
    expect(parseVerificationResult(null).verdict).toBe('inconclusive');
    expect(parseVerificationResult('a string').verdict).toBe('inconclusive');
    expect(parseVerificationResult({}).verdict).toBe('inconclusive');
  });
  it('returns inconclusive for an invalid verdict value', () => {
    expect(parseVerificationResult({ schemaVersion: 1, verdict: 'maybe' }).verdict).toBe('inconclusive');
  });
  it('drops malformed findings entries rather than throwing', () => {
    const raw = { schemaVersion: 1, verdict: 'supported', confidence: 1, summary: '', findings: ['not an object', { claim: 'x' }], tests: [], limitations: [] };
    const result = parseVerificationResult(raw);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].claim).toBe('x');
    expect(result.findings[0].severity).toBe('info');
  });
});
```

- [ ] **Step 4: Run to verify failure, then pass**

Run: `npx vitest run electron/crossEngine/verificationResult.test.ts`
Expected: FAIL, then PASS.

- [ ] **Step 5: Implement `CodexVerifier` orchestration**

```ts
// electron/crossEngine/codexVerifier.ts
import type { DatabaseSync } from 'node:sqlite';
import type { GitProbe } from '../../src/shared/projectIdentity';
import { resolveDispatchEvidence } from './dispatchEvidence';
import { buildVerificationSnapshot } from './snapshotBuilder';
import { buildVerificationPrompt } from './verificationPrompt';
import { parseVerificationResult } from './verificationResult';
import { AcpClient } from './acpClient';
import { isAllowedAuthStatus } from './codexSubscriptionPolicy';
import type { VerificationRequest, VerificationResultV1, VerificationEvent } from '../../src/shared/crossEngineTypes';

const RUN_TIMEOUT_MS = 5 * 60_000;

export class CodexVerifier {
  private activeRunId: string | null = null;
  private activeClient: AcpClient | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly sessionDir: string,
    private readonly pinnedSessionId: string,
    private readonly gitProbe: GitProbe
  ) {}

  async run(runId: string, request: VerificationRequest, onEvent: (e: VerificationEvent) => void): Promise<VerificationResultV1> {
    if (this.activeRunId) throw new Error('a verification run is already in progress');
    this.activeRunId = runId;

    let dispose: (() => Promise<void>) | null = null;
    const client = new AcpClient();
    this.activeClient = client;

    try {
      onEvent({ kind: 'status', runId, phase: 'preparing-evidence' });
      const evidenceResult = await resolveDispatchEvidence(request.toolUseId, this.db, this.sessionDir, this.pinnedSessionId, this.gitProbe);
      if (!evidenceResult.ok) {
        onEvent({ kind: 'error', runId, code: 'EVIDENCE_INCOMPLETE', message: evidenceResult.missing });
        return { schemaVersion: 1, verdict: 'inconclusive', confidence: 0, summary: evidenceResult.missing, findings: [], tests: [], limitations: [evidenceResult.missing] };
      }

      onEvent({ kind: 'status', runId, phase: 'creating-snapshot' });
      const snapshot = await buildVerificationSnapshot(evidenceResult.evidence);
      dispose = snapshot.dispose;

      onEvent({ kind: 'status', runId, phase: 'checking-auth' });
      client.connect();
      await client.initialize();
      await client.authenticate();
      const status = await client.authenticationStatus();
      if (!isAllowedAuthStatus(status)) {
        const message = `Codex authentication is not subscription-only (status: ${status}); refusing to run.`;
        onEvent({ kind: 'error', runId, code: 'BILLING_MODE_BLOCKED', message });
        return { schemaVersion: 1, verdict: 'inconclusive', confidence: 0, summary: message, findings: [], tests: [], limitations: [message] };
      }

      onEvent({ kind: 'status', runId, phase: 'verifying' });
      const prompt = buildVerificationPrompt(evidenceResult.evidence);
      const raw = await this.promptWithTimeout(client, snapshot.snapshotDir, prompt, RUN_TIMEOUT_MS);
      const result = parseVerificationResult(raw);
      onEvent({ kind: 'result', runId, result });
      return result;
    } finally {
      await client.dispose();
      if (dispose) await dispose();
      this.activeRunId = null;
      this.activeClient = null;
    }
  }

  private async promptWithTimeout(client: AcpClient, snapshotDir: string, prompt: string, timeoutMs: number): Promise<unknown> {
    // Delegates to the ACP session/prompt call once acpClient.ts exposes a
    // typed prompt(sessionParams) method -- wired here rather than in Task 2
    // because only this task knows the read-only/no-MCP/no-web-search
    // session parameters a verification run requires.
    return Promise.race([
      client.prompt({ cwd: snapshotDir, text: prompt, permissionMode: 'read-only', mcpServers: [], webSearch: false }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('VERIFICATION_TIMEOUT')), timeoutMs)),
    ]);
  }

  async cancel(runId: string): Promise<void> {
    if (this.activeRunId !== runId || !this.activeClient) return;
    await this.activeClient.dispose();
  }
}
```

Add the `prompt(params)` method this file calls to `AcpClient` (Task 2's
`acpClient.ts`) now that its exact shape is known: a thin wrapper over
`this.call('session/prompt', params)` returning the parsed JSON payload from
the final `agent_message` event in the ACP response stream. Read the
`@agentclientprotocol/sdk` types once installed (Task 2, Step 1) to get the
exact `session/new` + `session/prompt` method names and payload shape right —
do not guess the wire format; the installed package's `.d.ts` is authoritative.

- [ ] **Step 6: Write the failing orchestration tests with a fake ACP process**

```ts
// electron/crossEngine/codexVerifier.test.ts
import { describe, it, expect } from 'vitest';
import { CodexVerifier } from './codexVerifier';
// Build on the fakeChild()/respondTo() helpers from acpClient.test.ts (Task 2)
// to script a full initialize -> authenticate -> status -> prompt exchange.

describe('CodexVerifier.run', () => {
  it('returns inconclusive without connecting when evidence is incomplete', async () => { /* ... */ });
  it('refuses to run and reports BILLING_MODE_BLOCKED when status is api-key after apparent success', async () => { /* ... */ });
  it('refuses to run when status changes from chat-gpt to api-key between probe and this run', async () => { /* ... */ });
  it('returns a validated result on a well-formed Codex response', async () => { /* ... */ });
  it('cleans up the snapshot and client on timeout', async () => { /* ... */ });
  it('cleans up on cancellation', async () => { /* ... */ });
  it('cleans up on a child process crash mid-run', async () => { /* ... */ });
  it('rejects a second concurrent run while one is active', async () => { /* ... */ });
});
```

- [ ] **Step 7: Run to verify failure, then pass**

Run: `npx vitest run electron/crossEngine/codexVerifier.test.ts`
Expected: FAIL, then PASS.

- [ ] **Step 8: Verify and commit**

Run: `npx tsc -b`, `npx vitest run`, `npm run build`. All exit 0.

```bash
git add electron/crossEngine/verificationPrompt.ts electron/crossEngine/verificationResult.ts electron/crossEngine/verificationResult.test.ts electron/crossEngine/codexVerifier.ts electron/crossEngine/codexVerifier.test.ts electron/crossEngine/acpClient.ts
git commit -m "feat(cross-engine): verify dispatch artifacts with Codex"
```

---

### Task 5: Narrow IPC and UI

**Files:**
- Modify: `electron/main.ts`, `electron/preload.ts`, `src/aetherElectron.d.ts`
- Modify: `src/state/types.ts`, `src/state/reducer.ts`, `src/state/reducer.test.ts`, `src/state/initialState.ts`, `src/state/persistence.ts`
- Create: `src/components/settings/CrossEngineVerificationCard.tsx`, `src/components/settings/CrossEngineVerificationCard.test.tsx`
- Create: `src/components/agents/VerifyWithCodexButton.tsx`, `src/components/agents/VerifyWithCodexButton.test.tsx`

**Interfaces:**
- Consumes: `CodexVerifier` (Task 4); `VerifierStatus`, `VerificationRequest`, `VerificationEvent` (Task 2).
- Produces: `window.aetherElectron.crossEngine.{status,connectCodexSubscription,verifyDispatch,cancel,onUpdate}`;
  `state.crossEngineCfg: { enabled: boolean; provider: 'codex-chatgpt' }`; action
  `{ type: 'SET_CROSS_ENGINE_CFG'; cfg: { enabled: boolean; provider: 'codex-chatgpt' } }`.

- [ ] **Step 1: Add state slice, action, reducer, persistence, initial state**

In `src/state/types.ts`: `crossEngineCfg: { enabled: boolean; provider: 'codex-chatgpt' };`

In `src/state/reducer.ts`: action member
`{ type: 'SET_CROSS_ENGINE_CFG'; cfg: { enabled: boolean; provider: 'codex-chatgpt' } }`,
case `return { ...state, crossEngineCfg: action.cfg };`.

In `src/state/initialState.ts`: `crossEngineCfg: { enabled: false, provider: 'codex-chatgpt' },`

In `src/state/persistence.ts`: `crossEngineCfg` is the ONE new field that IS
persisted (unlike `ledger`/`projectsSnapshot`) — it's user intent, not
recomputed state, matching the spec's §11. Add it to the persisted whitelist,
not the exclusions list.

- [ ] **Step 2: Write and run the reducer test**

```ts
it('SET_CROSS_ENGINE_CFG replaces crossEngineCfg wholesale', () => {
  const cfg = { enabled: true, provider: 'codex-chatgpt' as const };
  const next = reducer(initialState, { type: 'SET_CROSS_ENGINE_CFG', cfg });
  expect(next.crossEngineCfg).toEqual(cfg);
});
```

Run: `npx vitest run src/state/reducer.test.ts src/state/persistence.test.ts`
Expected: PASS.

- [ ] **Step 3: Wire main.ts — construct verifier, register IPC handlers**

In `electron/main.ts`, near the other feature wiring: construct one
`CodexVerifier` instance (module-level, lazily connected — no process spawned
until the first `status()`/`verifyDispatch()` call, since the toggle defaults
off), and register handlers:

```ts
ipcMain.handle('crossEngine:status', async () => {
  if (!crossEngineEnabled()) return 'disabled';
  return codexClient.probe();
});

ipcMain.handle('crossEngine:connectCodexSubscription', async () => {
  await codexClient.initialize();
  await codexClient.authenticate();
  const status = await codexClient.authenticationStatus();
  return isAllowedAuthStatus(status) ? 'ready-subscription' : 'blocked-billing-mode';
});

ipcMain.handle('crossEngine:verifyDispatch', async (_event, toolUseId: string) => {
  if (typeof toolUseId !== 'string' || !toolUseId) throw new Error('invalid dispatch id');
  const runId = crypto.randomUUID();
  verifier
    .run(runId, { toolUseId }, (e) => sendToWindow('crossEngine:update', e))
    .catch((err) => sendToWindow('crossEngine:update', { kind: 'error', runId, code: 'RESULT_INVALID', message: String(err) }));
  return { runId };
});

ipcMain.handle('crossEngine:cancel', async (_event, runId: string) => {
  await verifier.cancel(runId);
});
```

(`crossEngineEnabled()` reads the persisted config the same way other
feature-gated main-process reads already do in this file — follow the
existing pattern rather than adding a new one.)

- [ ] **Step 4: Expose the preload bridge and its declaration together**

`electron/preload.ts`:

```ts
crossEngine: {
  status: (): Promise<VerifierStatus> => ipcRenderer.invoke('crossEngine:status'),
  connectCodexSubscription: (): Promise<VerifierStatus> => ipcRenderer.invoke('crossEngine:connectCodexSubscription'),
  verifyDispatch: (toolUseId: string): Promise<{ runId: string }> => ipcRenderer.invoke('crossEngine:verifyDispatch', toolUseId),
  cancel: (runId: string): Promise<void> => ipcRenderer.invoke('crossEngine:cancel', runId),
  onUpdate: (callback: (event: VerificationEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, event: VerificationEvent) => callback(event);
    ipcRenderer.on('crossEngine:update', listener);
    return () => ipcRenderer.removeListener('crossEngine:update', listener);
  },
},
```

`src/aetherElectron.d.ts`, same commit:

```ts
crossEngine: {
  status: () => Promise<VerifierStatus>;
  connectCodexSubscription: () => Promise<VerifierStatus>;
  verifyDispatch: (toolUseId: string) => Promise<{ runId: string }>;
  cancel: (runId: string) => Promise<void>;
  onUpdate: (callback: (event: VerificationEvent) => void) => () => void;
};
```

- [ ] **Step 5: Build the settings card**

```tsx
// src/components/settings/CrossEngineVerificationCard.tsx
import { useEffect, useState } from 'react';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { useAetherStore } from '../../state/store';
import type { VerifierStatus } from '../../shared/crossEngineTypes';

const DISCLOSURE =
  'Sends the selected verification snapshot to OpenAI Codex. Uses your ChatGPT Codex allowance. OpenAI API keys and custom gateways are blocked. No automatic fallback.';

export function CrossEngineVerificationCard() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const [status, setStatus] = useState<VerifierStatus>('disabled');
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!state.crossEngineCfg.enabled) return;
    window.aetherElectron?.crossEngine?.status().then(setStatus);
  }, [state.crossEngineCfg.enabled]);

  const toggle = () => {
    if (!state.crossEngineCfg.enabled) {
      setConfirming(true);
      return;
    }
    dispatch({ type: 'SET_CROSS_ENGINE_CFG', cfg: { enabled: false, provider: 'codex-chatgpt' } });
  };

  const confirmEnable = () => {
    setConfirming(false);
    dispatch({ type: 'SET_CROSS_ENGINE_CFG', cfg: { enabled: true, provider: 'codex-chatgpt' } });
  };

  const connect = async () => {
    const result = await window.aetherElectron?.crossEngine?.connectCodexSubscription();
    if (result) setStatus(result);
  };

  return (
    <div>
      <div>CROSS-ENGINE VERIFICATION</div>
      <Button onClick={toggle}>{state.crossEngineCfg.enabled ? 'DISABLE' : 'ENABLE'}</Button>
      {confirming && (
        <div>
          <p>{DISCLOSURE}</p>
          <Button onClick={confirmEnable}>I UNDERSTAND, ENABLE</Button>
          <Button onClick={() => setConfirming(false)}>CANCEL</Button>
        </div>
      )}
      {state.crossEngineCfg.enabled && (
        <>
          <div>PROVIDER: CODEX VIA CHATGPT</div>
          <div>BILLING: SUBSCRIPTION ONLY</div>
          <div>STATUS: {status}</div>
          <Button onClick={connect}>{status === 'ready-subscription' ? 'RECONNECT' : 'CONNECT CHATGPT'}</Button>
          <p>{DISCLOSURE}</p>
        </>
      )}
    </div>
  );
}
```

(Adapt styling to this repo's existing settings-card style-function
convention — follow a sibling in `src/components/settings/` for
`cardStyle`/`titleStyle` exactly, the way Stage 16's roster card did.)

- [ ] **Step 6: Write the failing settings-card tests**

```tsx
// src/components/settings/CrossEngineVerificationCard.test.tsx
describe('CrossEngineVerificationCard', () => {
  it('defaults to disabled', () => { /* enabled=false in initial state */ });
  it('requires explicit confirmation before first enablement', () => { /* click ENABLE -> disclosure shown, not yet enabled -> confirm -> enabled */ });
  it('shows SUBSCRIPTION ONLY billing label when enabled', () => { /* ... */ });
  it('never renders an API key input field anywhere', () => { /* queryByLabelText/api key absent */ });
});
```

- [ ] **Step 7: Run to verify failure, then pass**

Run: `npx vitest run src/components/settings/CrossEngineVerificationCard.test.tsx`
Expected: FAIL, then PASS.

- [ ] **Step 8: Build the dispatch action button**

```tsx
// src/components/agents/VerifyWithCodexButton.tsx
import { useState } from 'react';
import { Button } from '../shared/Button';
import { useAetherStore } from '../../state/store';

export function VerifyWithCodexButton({ toolUseId, evidenceSufficient }: { toolUseId: string; evidenceSufficient: boolean }) {
  const { state } = useAetherStore();
  const [running, setRunning] = useState(false);

  const disabledReason = !state.crossEngineCfg.enabled
    ? 'Cross-engine verification is off'
    : !evidenceSufficient
      ? 'Evidence unavailable for this dispatch'
      : running
        ? 'A verification is already running'
        : null;

  const run = async () => {
    setRunning(true);
    try {
      await window.aetherElectron?.crossEngine?.verifyDispatch(toolUseId);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Button onClick={run} disabled={disabledReason !== null} title={disabledReason ?? undefined}>
      VERIFY WITH CODEX
    </Button>
  );
}
```

- [ ] **Step 9: Write and run the button tests**

```tsx
// src/components/agents/VerifyWithCodexButton.test.tsx
describe('VerifyWithCodexButton', () => {
  it('is disabled with a named reason when the feature is off', () => { /* ... */ });
  it('is disabled with a named reason when evidence is insufficient', () => { /* ... */ });
  it('invokes verifyDispatch with the given toolUseId when clicked and enabled', () => { /* ... */ });
});
```

Run: `npx vitest run src/components/agents/VerifyWithCodexButton.test.tsx`
Expected: PASS.

- [ ] **Step 10: Verify and commit**

Run: `npx tsc -b`, `npx vitest run`, `npm run build`, `npm run electron:build`.
All exit 0.

```bash
git add electron/main.ts electron/preload.ts src/aetherElectron.d.ts src/state src/components/settings/CrossEngineVerificationCard.tsx src/components/settings/CrossEngineVerificationCard.test.tsx src/components/agents/VerifyWithCodexButton.tsx src/components/agents/VerifyWithCodexButton.test.tsx
git commit -m "feat(cross-engine): expose manual Codex verification in Aether"
```

---

### Task 6: Refactor the capability guard; amend privacy, README, and idea docs

**Files:**
- Modify: `src/shared/noApiCalls.test.ts`
- Modify: `docs/privacy-and-data.md`, `README.md`, `docs/ideas/cross-engine-verification.md`, `docs/roadmap.md`

**Interfaces:** none new — this task closes out Task 1's guard additions against
the finished feature, and reconciles documentation with what shipped.

- [ ] **Step 1: Finalize the capability guard**

Revisit `src/shared/noApiCalls.test.ts` (extended in Task 1) now that the real
module tree exists. Add the remaining assertions from spec §12 not yet
covered: the child-environment builder removes every blocked billing
variable (already covered by Task 1's `acpProcess.test.ts` — cross-reference
rather than duplicate), authentication status is `chat-gpt` before session
creation (covered by `codexVerifier.test.ts` — cross-reference), and no raw
verification payload type (`VerificationResultV1`'s `findings`/summary
content, not the type itself) is reachable from `persistence.ts`'s persisted
whitelist — grep `persistence.ts`'s persisted-fields list and assert
`crossEngineCfg` is the only cross-engine-related key present.

- [ ] **Step 2: Run the full guard suite**

Run: `npx vitest run src/shared/noApiCalls.test.ts`
Expected: PASS.

- [ ] **Step 3: Amend `docs/privacy-and-data.md`**

Add a new section stating exactly the points spec §3.4 requires: cross-engine
verification is the only new outbound content path; default-off; explicit
opt-in required; sends only the selected verification snapshot and prompt;
authenticates through the user's ChatGPT account; cannot use an OpenAI API
key; raw prompts/diffs/source/responses are not persisted; disabling the
feature terminates the adapter and removes the in-memory payload. This
supersedes the document's current "no feature in this app makes a network
request" language — correct that sentence to name this one exception
explicitly rather than leaving it contradicted.

- [ ] **Step 4: Correct README.md**

Update any claim of "no model call site" / "nothing leaves the machine" to
name the one explicit, default-off, opt-in exception, using the spec §2.4
approved language.

- [ ] **Step 5: Update the idea doc**

In `docs/ideas/cross-engine-verification.md`, change `**Status:** parked` to
`**Status:** implemented — see docs/superpowers/plans/2026-08-07-codex-acp-cross-engine-verification.md`
and add a short note that the shipped version is subscription-only ChatGPT
billing, resolving the "second subscription, real cost" obstacle originally
named in the doc's "Obstacles, honestly" section.

- [ ] **Step 6: Add the roadmap row**

In `docs/roadmap.md`, following the established table row format for a
shipped stage, add this feature with a link to this plan and the design spec,
noting the privacy-doc amendment and that automatic anomaly-triggered
verification remains a deliberately deferred follow-on (spec §15's "do not
enable anomaly-triggered automatic verification in this sequence").

- [ ] **Step 7: Commit**

```bash
git add src/shared/noApiCalls.test.ts docs/privacy-and-data.md README.md docs/ideas/cross-engine-verification.md docs/roadmap.md
git commit -m "docs(cross-engine): document Codex privacy and billing boundary"
```

---

### Task 7: Full verification and real billing canary

**Files:** none — verification only.

- [ ] **Step 1: Full automated suite**

Run in order, all must exit 0:
```bash
npm test
npx tsc -b
npm run build
npm run electron:build
```

- [ ] **Step 2: Playwright Electron e2e**

Add/extend Electron e2e coverage (following this repo's existing Playwright
`_electron` pattern from Stage 9's hardening plan) for: toggle defaults off;
first enablement requires the privacy confirmation dialog; sign-in-required
state renders correctly; connected state renders "SUBSCRIPTION ONLY"; the
dispatch button is shown only when evidence is sufficient; running,
cancellation, inconclusive, contradicted, and supported states all render;
app restart preserves the opt-in boolean but not any result payload or
credential in application state.

Run: the project's Playwright command (check `package.json` scripts).
Expected: PASS. If this development environment is headless with no display
(the same constraint Stages 4-9 already documented), name that limitation
plainly in this task's completion notes rather than skipping silently —
follow the precedent set by every prior stage's roadmap row.

- [ ] **Step 3: Manual canary — home computer**

Perform only after Steps 1-2 pass, and only with the operator present (this
step requires a real ChatGPT login and cannot be automated):

1. Record the OpenAI Platform API usage dashboard state.
2. Record the ChatGPT/Codex usage status.
3. Enable the feature in a running Aether OS window.
4. Complete ChatGPT browser login in Aether's dedicated Codex home.
5. Verify one small, known dispatch.
6. Confirm ChatGPT/Codex usage changed as expected.
7. Confirm OpenAI Platform API usage did NOT change.
8. Confirm no API-key or gateway option appeared anywhere in the UI.

- [ ] **Step 4: Manual canary — office computer**

Repeat Step 3 with an independent ChatGPT login (do not copy `auth.json`
between machines — each dedicated `CODEX_HOME` gets its own login) and
confirm both machines draw from the same ChatGPT account allowance.

- [ ] **Step 5: Whole-branch review**

Dispatch the final whole-branch review per this repo's established
subagent-driven-development convention, on the most capable available model,
with these four required questions (spec's own definition-of-done, §16),
answered by reading the actual code:

1. Can the renderer ever supply a path, ACP method, auth method, executable,
   or provider — anywhere, including through an unvalidated IPC argument?
2. Is `authentication/status` checked immediately before every single
   verification turn, not only at connect time, and does every non-`chat-gpt`
   status (including malformed/timeout/unknown) fail closed?
3. Is any raw prompt, diff, claim, source file, or Codex response reachable
   from `persistence.ts`'s persisted whitelist, from SQLite, or from a log?
4. Does `docs/privacy-and-data.md`'s "nothing leaves this machine" claim now
   correctly name this feature as the sole, explicit, default-off exception —
   with no other sentence in the document left contradicting it?

- [ ] **Step 6: Record the canary and close the loop**

Document the canary results (Steps 3-4) in this plan's completion notes or a
short dated addendum to the design spec — the spec's §14.4 states the
implementation is not accepted until this canary is documented.
