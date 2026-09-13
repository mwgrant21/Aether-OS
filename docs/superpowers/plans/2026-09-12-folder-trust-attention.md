# Folder-Trust Attention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare `Bridge: waiting.` status with an evidence-backed attention state that tells the operator when the connected Claude client is blocked on the folder-trust prompt, stalled, or exited.

**Architecture:** A pure `trustAttention` module derives an `{state, trust, since}` value from four inputs — a deterministic pre-launch trust precheck, a PTY prompt matcher, authoritative launch completion, and elapsed time. It is exposed as a new optional sibling field on the bridge snapshot; the `readiness` union is deliberately not widened, so every existing consumer is untouched.

**Tech Stack:** TypeScript, Electron main/renderer split, Vitest, React.

**Spec:** `docs/superpowers/specs/2026-09-12-folder-trust-attention-design.md`

## Global Constraints

- Target worktree: `.worktrees/visible-communication-u1`, branch `feat/visible-communication-u1`. Run all commands from that directory.
- Test runner: `npx vitest run <path>` for one file, `npm test` for the full suite (1,691 tests currently passing).
- Electron typecheck: `npm run typecheck:electron`.
- Interfaces in `src/shared/communicationTypes.ts` use `readonly` members. Match that.
- **No copy anywhere may say "press Enter".** Enter selects "No, exit" on the trust prompt — it is the destructive default.
- **No copy may tell the operator to trust the folder outright.** Copy directs them to review it first.
- Aether must never write `hasTrustDialogAccepted` on the operator's behalf.
- Changing the launch cwd is out of scope. Do not touch `ptyManager.ts:58` or the `workingDirectory` in `launchConfig.ts:172`.
- `stripAnsi` deletes CSI cursor-forward sequences outright. Prompt words arrive separated by `ESC[1C`, so stripped text reads `Yes,Itrustthisfolder`. **Every inter-word gap in a prompt regex must be `\s*`, never a literal space.**

---

### Task 1: Trust-prompt PTY matcher

**Files:**
- Create: `electron/communicationBridge/trustPromptMatcher.ts`
- Create: `electron/communicationBridge/trustPromptMatcher.test.ts`
- Already present (committed in this plan's prep): `electron/__fixtures__/trust-prompt-capture.json`

**Interfaces:**
- Consumes: `stripAnsi` from `electron/ansiStrip.ts`.
- Produces: `createTrustPromptMatcher(now?: () => number)` returning `{ ingest(chunk: string): void; state(): TrustPromptState; reset(): void }` where `TrustPromptState = { readonly seenAt: number | null; readonly active: boolean }`.

The fixture is a real PTY capture: 8 chunks, last output at 562 ms, then silence for the remaining 24.4 s. That silence is what makes `active` decidable — any printable output after the match means the client moved on.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { createTrustPromptMatcher } from './trustPromptMatcher';
import capture from '../__fixtures__/trust-prompt-capture.json';

const chunks: { at: number; data: string }[] = capture.chunks;

describe('createTrustPromptMatcher', () => {
  it('matches the real captured folder-trust prompt', () => {
    const matcher = createTrustPromptMatcher(() => 1000);
    for (const chunk of chunks) matcher.ingest(chunk.data);
    expect(matcher.state()).toEqual({ seenAt: 1000, active: true });
  });

  it('does not match ordinary session output', () => {
    const matcher = createTrustPromptMatcher(() => 1000);
    matcher.ingest('Running tests...\nNo, exit was mentioned in a log line\n');
    expect(matcher.state()).toEqual({ seenAt: null, active: false });
  });

  it('clears active once printable output arrives after the prompt', () => {
    const matcher = createTrustPromptMatcher(() => 1000);
    for (const chunk of chunks) matcher.ingest(chunk.data);
    matcher.ingest('\u001b[2J Welcome to Claude Code\n');
    expect(matcher.state()).toEqual({ seenAt: 1000, active: false });
  });

  it('ignores escape-only repaints that carry no printable text', () => {
    const matcher = createTrustPromptMatcher(() => 1000);
    for (const chunk of chunks) matcher.ingest(chunk.data);
    matcher.ingest('\u001b[?25l\u001b[?25h');
    expect(matcher.state().active).toBe(true);
  });

  it('never re-stamps seenAt on repeated ingestion', () => {
    let clock = 1000;
    const matcher = createTrustPromptMatcher(() => clock);
    for (const chunk of chunks) matcher.ingest(chunk.data);
    clock = 9999;
    for (const chunk of chunks) matcher.ingest(chunk.data);
    expect(matcher.state().seenAt).toBe(1000);
  });

  it('reset returns to the initial state', () => {
    const matcher = createTrustPromptMatcher(() => 1000);
    for (const chunk of chunks) matcher.ingest(chunk.data);
    matcher.reset();
    expect(matcher.state()).toEqual({ seenAt: null, active: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/communicationBridge/trustPromptMatcher.test.ts`
Expected: FAIL — cannot resolve `./trustPromptMatcher`.

- [ ] **Step 3: Write the implementation**

```ts
import { stripAnsi } from '../ansiStrip';

const BUFFER_CAP = 16384;

// Calibrated against electron/__fixtures__/trust-prompt-capture.json, a real PTY
// capture of the Claude Code folder-trust prompt. The prompt separates its words
// with CSI cursor-forward sequences (ESC[1C) rather than spaces, and ansiStrip
// deletes those outright -- the stripped text reads "Yes,Itrustthisfolder". Every
// inter-word gap must therefore be \s* and never a literal space. Both option
// labels are required together so ordinary session output that happens to contain
// one of them cannot raise a false positive.
const EXIT_OPTION = /No,\s*exit/i;
const TRUST_OPTION = /Yes,\s*I\s*trust\s*this\s*folder/i;

export interface TrustPromptState {
  readonly seenAt: number | null;
  readonly active: boolean;
}

export function createTrustPromptMatcher(now: () => number = Date.now) {
  let buffer = '';
  let seenAt: number | null = null;
  let active = false;

  function ingest(chunk: string): void {
    try {
      const text = stripAnsi(chunk);
      // The capture shows the TUI emits nothing at all while the prompt waits
      // (last byte at 562ms, then silence to the 25s cutoff). So any printable
      // output after the match is real progress: the operator answered, or the
      // client exited. Escape-only repaints strip to empty and are ignored.
      if (seenAt !== null && text.trim() !== '') active = false;
      buffer = (buffer + text).slice(-BUFFER_CAP);
      if (seenAt === null && EXIT_OPTION.test(buffer) && TRUST_OPTION.test(buffer)) {
        seenAt = now();
        active = true;
      }
    } catch {
      /* parsing must never break the pty data path -- same rule as planUsageScraper */
    }
  }

  return {
    ingest,
    state: (): TrustPromptState => ({ seenAt, active }),
    reset(): void { buffer = ''; seenAt = null; active = false; },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/communicationBridge/trustPromptMatcher.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/communicationBridge/trustPromptMatcher.ts electron/communicationBridge/trustPromptMatcher.test.ts electron/__fixtures__/trust-prompt-capture.json
git commit -m "feat(communication): match the folder-trust prompt in the bridge pty stream"
```

---

### Task 2: Attention type and snapshot field

**Files:**
- Modify: `src/shared/communicationTypes.ts` (append after `ProviderState`, around line 16)
- Modify: `electron/communicationBridge/mainIntegration.ts:7-13` (the `CommunicationBridgeSnapshot` interface)

**Interfaces:**
- Produces: `Attention`, `AttentionState`, `AttentionTrust` exported from `src/shared/communicationTypes.ts`; `CommunicationBridgeSnapshot.attention?: Attention`.

This task is type-only. `snapshot()` does not yet populate the field — Task 5 wires it. Splitting it this way keeps the projector work (Task 4) reviewable on its own.

- [ ] **Step 1: Add the types**

In `src/shared/communicationTypes.ts`, after the `ProviderState` declaration:

```ts
/** Lifecycle: what happened to the connected client. */
export type AttentionState = 'blocked' | 'exited' | 'stalled';
/** Evidence: what the trust config and the pty actually showed. */
export type AttentionTrust = 'unaccepted' | 'prompt-seen' | 'unknown' | 'not-implicated';
/** State and trust are independent: an exit can be certain while its cause is not. */
export interface Attention {
  readonly state: AttentionState;
  readonly trust: AttentionTrust;
  readonly since: number;
}
```

- [ ] **Step 2: Add the snapshot field**

In `electron/communicationBridge/mainIntegration.ts`, import the type alongside the existing shared-type import and add the field to `CommunicationBridgeSnapshot`:

```ts
import type { Attention, CommunicationMetadata, CommunicationPayload } from '../../src/shared/communicationTypes';
```

```ts
export interface CommunicationBridgeSnapshot {
  readonly enabled: boolean;
  readonly readiness: 'disabled' | 'waiting' | 'authenticated' | 'ready' | 'disconnected';
  readonly cleanup: 'confirmed' | 'pending' | 'failed';
  readonly metadata: readonly CommunicationMetadata[];
  readonly remainingCredits?: number | null;
  readonly attention?: Attention;
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run typecheck:electron`
Expected: clean exit.

- [ ] **Step 4: Commit**

```bash
git add src/shared/communicationTypes.ts electron/communicationBridge/mainIntegration.ts
git commit -m "feat(communication): declare the attention contract on the bridge snapshot"
```

---

### Task 3: Attention derivation

**Files:**
- Create: `electron/communicationBridge/trustAttention.ts`
- Create: `electron/communicationBridge/trustAttention.test.ts`

**Interfaces:**
- Consumes: `Attention` from `src/shared/communicationTypes.ts`; `CommunicationBridgeSnapshot['readiness']` from `./mainIntegration`.
- Produces: `TRUST_GRACE_MS`, `TRUST_STALL_MS`, `LaunchCompletion`, `TrustAttentionInputs`, `deriveAttention(i): Omit<Attention, 'since'> | undefined`, and `createTrustAttention()` returning `{ update(i): Attention | undefined; nextDeadline(i): number | null }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { createTrustAttention, deriveAttention, TRUST_GRACE_MS, TRUST_STALL_MS,
  type TrustAttentionInputs } from './trustAttention';

const base: TrustAttentionInputs = {
  launchId: 'L1', readiness: 'waiting', trustedAtLaunch: true,
  promptSeenAt: null, promptActive: false, completion: 'running',
  spawnedAt: 0, now: 0,
};
const at = (over: Partial<TrustAttentionInputs>): TrustAttentionInputs => ({ ...base, ...over });

describe('deriveAttention', () => {
  it('reports nothing during a healthy early wait', () => {
    expect(deriveAttention(at({ now: 500 }))).toBeUndefined();
  });

  it('never claims an exit before the client has spawned', () => {
    expect(deriveAttention(at({ completion: 'starting', spawnedAt: null, now: 60_000 }))).toBeUndefined();
  });

  it('reports an exit at any readiness, including disconnected', () => {
    expect(deriveAttention(at({ completion: 'exited', readiness: 'disconnected' })))
      .toEqual({ state: 'exited', trust: 'not-implicated' });
  });

  it('attributes an exit to the prompt when the prompt was seen', () => {
    expect(deriveAttention(at({ completion: 'exited', promptSeenAt: 10 })))
      .toEqual({ state: 'exited', trust: 'prompt-seen' });
  });

  it('blocks on an active prompt', () => {
    expect(deriveAttention(at({ promptActive: true, promptSeenAt: 10, now: 600 })))
      .toEqual({ state: 'blocked', trust: 'prompt-seen' });
  });

  it('suspects folder trust from the precheck after the grace period', () => {
    expect(deriveAttention(at({ trustedAtLaunch: false, now: TRUST_GRACE_MS })))
      .toEqual({ state: 'blocked', trust: 'unaccepted' });
  });

  it('does not suspect folder trust when the config was merely unreadable', () => {
    expect(deriveAttention(at({ trustedAtLaunch: 'unknown', now: TRUST_GRACE_MS }))).toBeUndefined();
  });

  it('escalates to stalled even when trust is implicated, keeping the evidence', () => {
    expect(deriveAttention(at({ trustedAtLaunch: false, now: TRUST_STALL_MS })))
      .toEqual({ state: 'stalled', trust: 'unaccepted' });
  });

  it('covers a stall at authenticated, not just waiting', () => {
    expect(deriveAttention(at({ readiness: 'authenticated', now: TRUST_STALL_MS })))
      .toEqual({ state: 'stalled', trust: 'not-implicated' });
  });

  it('reports nothing once readiness reaches ready', () => {
    expect(deriveAttention(at({ readiness: 'ready', now: TRUST_STALL_MS }))).toBeUndefined();
  });

  it('keeps an active prompt blocked however long it waits', () => {
    expect(deriveAttention(at({ promptActive: true, promptSeenAt: 10, now: 10 * TRUST_STALL_MS })))
      .toEqual({ state: 'blocked', trust: 'prompt-seen' });
  });
});

describe('createTrustAttention', () => {
  it('stamps since once and preserves it across a trust change', () => {
    const holder = createTrustAttention();
    const first = holder.update(at({ trustedAtLaunch: false, now: TRUST_GRACE_MS }));
    expect(first).toEqual({ state: 'blocked', trust: 'unaccepted', since: TRUST_GRACE_MS });
    const later = holder.update(at({ trustedAtLaunch: false, promptSeenAt: 1, promptActive: true, now: 9_000 }));
    expect(later).toEqual({ state: 'blocked', trust: 'prompt-seen', since: TRUST_GRACE_MS });
  });

  it('preserves since across an escalation to stalled', () => {
    const holder = createTrustAttention();
    holder.update(at({ trustedAtLaunch: false, now: TRUST_GRACE_MS }));
    const stalled = holder.update(at({ trustedAtLaunch: false, now: TRUST_STALL_MS }));
    expect(stalled).toEqual({ state: 'stalled', trust: 'unaccepted', since: TRUST_GRACE_MS });
  });

  it('clears and re-stamps after the attention lapses', () => {
    const holder = createTrustAttention();
    holder.update(at({ trustedAtLaunch: false, now: TRUST_GRACE_MS }));
    expect(holder.update(at({ readiness: 'ready', now: 5_000 }))).toBeUndefined();
    const again = holder.update(at({ trustedAtLaunch: false, now: 8_000 }));
    expect(again).toEqual({ state: 'blocked', trust: 'unaccepted', since: 8_000 });
  });

  it('resets everything when the launch id changes', () => {
    const holder = createTrustAttention();
    holder.update(at({ trustedAtLaunch: false, now: TRUST_GRACE_MS }));
    const next = holder.update(at({ launchId: 'L2', trustedAtLaunch: false, now: 100_000 }));
    expect(next).toEqual({ state: 'blocked', trust: 'unaccepted', since: 100_000 });
  });

  it('returns only future deadlines and null once exhausted', () => {
    const holder = createTrustAttention();
    expect(holder.nextDeadline(at({ trustedAtLaunch: false, now: 0 }))).toBe(TRUST_GRACE_MS);
    expect(holder.nextDeadline(at({ trustedAtLaunch: false, now: TRUST_GRACE_MS }))).toBe(TRUST_STALL_MS);
    expect(holder.nextDeadline(at({ trustedAtLaunch: false, now: TRUST_STALL_MS }))).toBeNull();
    expect(holder.nextDeadline(at({ readiness: 'ready', now: 0 }))).toBeNull();
    expect(holder.nextDeadline(at({ promptActive: true, now: 0 }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/communicationBridge/trustAttention.test.ts`
Expected: FAIL — cannot resolve `./trustAttention`.

- [ ] **Step 3: Write the implementation**

```ts
import type { Attention, AttentionTrust } from '../../src/shared/communicationTypes';
import type { CommunicationBridgeSnapshot } from './mainIntegration';

// Provisional. The real capture shows the trust prompt renders 562ms after spawn,
// so GRACE only needs to outlast a render the matcher will usually catch first.
// STALL has no measured healthy-handshake baseline yet -- deliberately generous,
// because a nagging stall banner is worse than a late one. Recalibrate against
// real healthy launches once one can be measured end to end.
export const TRUST_GRACE_MS = 3_000;
export const TRUST_STALL_MS = 20_000;

export type LaunchCompletion = 'starting' | 'running' | 'exited' | 'failed';

export interface TrustAttentionInputs {
  readonly launchId: string | null;
  readonly readiness: CommunicationBridgeSnapshot['readiness'];
  readonly trustedAtLaunch: true | false | 'unknown';
  readonly promptSeenAt: number | null;
  readonly promptActive: boolean;
  readonly completion: LaunchCompletion;
  readonly spawnedAt: number | null;
  readonly now: number;
}

function trustEvidence(i: TrustAttentionInputs): AttentionTrust {
  if (i.promptSeenAt !== null) return 'prompt-seen';
  if (i.trustedAtLaunch === false) return 'unaccepted';
  if (i.trustedAtLaunch === 'unknown') return 'unknown';
  return 'not-implicated';
}

/** An exit is reportable at ANY readiness -- readiness falls to 'disconnected' on
 * teardown, and gating on 'waiting' would erase the diagnosis exactly when it
 * matters. Every other rule applies only while the client could still connect. */
export function deriveAttention(i: TrustAttentionInputs): Omit<Attention, 'since'> | undefined {
  if (i.launchId === null) return undefined;
  if (i.completion === 'exited' || i.completion === 'failed') return { state: 'exited', trust: trustEvidence(i) };
  if (i.completion === 'starting') return undefined;
  if (i.readiness !== 'waiting' && i.readiness !== 'authenticated') return undefined;
  if (i.promptActive) return { state: 'blocked', trust: 'prompt-seen' };
  const elapsed = i.spawnedAt === null ? 0 : i.now - i.spawnedAt;
  // STALL is checked before GRACE on purpose. Both can be true at once; the stall
  // reading must win so a long wait escalates to "this is not connecting" instead
  // of repeating "likely folder trust" forever. Trust evidence is retained either way.
  if (elapsed >= TRUST_STALL_MS) return { state: 'stalled', trust: trustEvidence(i) };
  if (i.trustedAtLaunch === false && elapsed >= TRUST_GRACE_MS) return { state: 'blocked', trust: 'unaccepted' };
  return undefined;
}

export function createTrustAttention() {
  let launchId: string | null = null;
  let raised = false;
  let since = 0;

  return {
    /** `since` marks when the episode began, so it survives every state and trust
     * change within one launch and re-stamps only after the attention lapses. */
    update(i: TrustAttentionInputs): Attention | undefined {
      if (i.launchId !== launchId) { launchId = i.launchId; raised = false; since = 0; }
      const next = deriveAttention(i);
      if (!next) { raised = false; since = 0; return undefined; }
      if (!raised) { raised = true; since = i.now; }
      return { state: next.state, trust: next.trust, since };
    },
    /** Only FUTURE instants at which the output can actually change. Returning a
     * past or already-applied deadline lets the caller reschedule an expired timer. */
    nextDeadline(i: TrustAttentionInputs): number | null {
      if (i.launchId === null || i.spawnedAt === null) return null;
      if (i.completion !== 'running') return null;
      if (i.readiness !== 'waiting' && i.readiness !== 'authenticated') return null;
      if (i.promptActive) return null;
      const grace = i.spawnedAt + TRUST_GRACE_MS;
      const stall = i.spawnedAt + TRUST_STALL_MS;
      if (i.trustedAtLaunch === false && i.now < grace) return grace;
      if (i.now < stall) return stall;
      return null;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/communicationBridge/trustAttention.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/communicationBridge/trustAttention.ts electron/communicationBridge/trustAttention.test.ts
git commit -m "feat(communication): derive folder-trust attention from launch evidence"
```

---

### Task 4: Pre-launch trust precheck

**Files:**
- Modify: `electron/communicationBridge/launchConfig.ts` (add an exported function; reuses the existing `jsonFile` helper at line 37)
- Modify: `electron/communicationBridge/launchConfig.test.ts` (append a describe block)

**Interfaces:**
- Consumes: the module-private `jsonFile()` helper, and `homedir`/`resolve`/`join`, all already imported in the file.
- Produces: `readLaunchTrust(directory: string): Promise<true | false | 'unknown'>`.

Trust keys are stored forward-slashed (`C:/Users/Matt`) while `homedir()` returns backslashes, so comparison must go through `resolve()` + lowercase — the same normalization `checkPolicy` already uses at line 82.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLaunchTrust } from './launchConfig';

describe('readLaunchTrust', () => {
  it('returns false for a directory with no entry at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trust-precheck-'));
    try { expect(await readLaunchTrust(dir)).toBe(false); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reports the real home directory as a boolean, never a guess', async () => {
    const result = await readLaunchTrust(homedir());
    expect([true, false, 'unknown']).toContain(result);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/communicationBridge/launchConfig.test.ts -t readLaunchTrust`
Expected: FAIL — `readLaunchTrust` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `electron/communicationBridge/launchConfig.ts`:

```ts
/** Deterministic pre-launch evidence: does the client already trust this folder?
 * An absent entry means it has never been trusted, which is a real `false`. Only
 * an unreadable or malformed config yields 'unknown', and 'unknown' must never be
 * rendered as "not in the trusted list" -- we simply could not tell.
 * Keys are stored forward-slashed while homedir() is backslashed, so both sides go
 * through resolve() + lowercase, the same normalization checkPolicy already uses. */
export async function readLaunchTrust(directory: string): Promise<true | false | 'unknown'> {
  try {
    const user = await jsonFile(join(homedir(), '.claude.json'));
    const projects = user?.projects;
    if (!projects || typeof projects !== 'object') return false;
    const target = resolve(directory).toLowerCase();
    for (const [path, config] of Object.entries(projects)) {
      if (resolve(path).toLowerCase() !== target) continue;
      return !!config && typeof config === 'object'
        && (config as Record<string, unknown>).hasTrustDialogAccepted === true;
    }
    return false;
  } catch {
    return 'unknown';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/communicationBridge/launchConfig.test.ts`
Expected: PASS — the new tests plus all pre-existing tests in the file.

- [ ] **Step 5: Commit**

```bash
git add electron/communicationBridge/launchConfig.ts electron/communicationBridge/launchConfig.test.ts
git commit -m "feat(communication): read folder trust from the client config before launch"
```

---

### Task 5: Project attention across IPC

**Files:**
- Modify: `src/shared/communicationSnapshot.ts` (predicate near line 7, validation near line 13, return near line 39)
- Modify: `src/shared/communicationSnapshot.test.ts` (append)

**Interfaces:**
- Consumes: `Attention` from `./communicationTypes`; the existing `object` and `count` helpers.
- Produces: no new exports — `projectCommunicationSnapshot` gains `attention` passthrough.

`projectCommunicationSnapshot` is a strict allowlist projector. A field present on the type and on `snapshot()` but missing here type-checks cleanly and silently never reaches the renderer. The guard test exists to catch that for every future field, not just this one.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { projectCommunicationSnapshot } from './communicationSnapshot';
import type { CommunicationBridgeSnapshot } from '../../electron/communicationBridge/mainIntegration';

const full: CommunicationBridgeSnapshot = {
  enabled: true, readiness: 'waiting', cleanup: 'confirmed', metadata: [],
  remainingCredits: 3, attention: { state: 'blocked', trust: 'unaccepted', since: 5 },
};

describe('projectCommunicationSnapshot attention', () => {
  it('carries a well-formed attention through', () => {
    expect(projectCommunicationSnapshot(full)?.attention)
      .toEqual({ state: 'blocked', trust: 'unaccepted', since: 5 });
  });

  it('accepts a snapshot with no attention at all', () => {
    const { attention, ...rest } = full;
    const projected = projectCommunicationSnapshot(rest);
    expect(projected).not.toBeNull();
    expect(projected!.attention).toBeUndefined();
  });

  it.each([
    ['bad state', { state: 'nope', trust: 'unaccepted', since: 5 }],
    ['bad trust', { state: 'blocked', trust: 'nope', since: 5 }],
    ['negative since', { state: 'blocked', trust: 'unaccepted', since: -1 }],
    ['non-integer since', { state: 'blocked', trust: 'unaccepted', since: 1.5 }],
    ['not an object', 'blocked'],
  ])('rejects the whole snapshot on %s', (_label, attention) => {
    expect(projectCommunicationSnapshot({ ...full, attention })).toBeNull();
  });

  it('drops attention when it disappears, so the renderer can clear', () => {
    const { attention, ...rest } = full;
    expect('attention' in projectCommunicationSnapshot(rest)!).toBe(false);
  });

  it('projects every top-level key of a fully-populated snapshot', () => {
    const projected = projectCommunicationSnapshot(full);
    expect(projected).not.toBeNull();
    expect(Object.keys(projected!).sort()).toEqual(Object.keys(full).sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/communicationSnapshot.test.ts -t attention`
Expected: FAIL — `attention` is dropped, so the first test gets `undefined`.

- [ ] **Step 3: Write the implementation**

Add the predicate beside the existing `cleanup` predicate in `src/shared/communicationSnapshot.ts`:

```ts
const attention = (value: unknown): value is Attention => object(value)
  && ['blocked', 'exited', 'stalled'].includes(value.state as string)
  && ['unaccepted', 'prompt-seen', 'unknown', 'not-implicated'].includes(value.trust as string)
  && count(value.since);
```

Import the type at the top of the file:

```ts
import type { Attention, CommunicationMetadata } from './communicationTypes';
```

Reject malformed input alongside the other top-level field checks, immediately after the existing `readiness`/`metadata` guard:

```ts
if (value.attention !== undefined && !attention(value.attention)) return null;
```

Copy it field-by-field in the return, mirroring the `remainingCredits` spread:

```ts
return { enabled: snapshot.enabled, readiness: snapshot.readiness, cleanup: snapshot.cleanup, metadata,
  ...(count(snapshot.remainingCredits) ? { remainingCredits: snapshot.remainingCredits } : {}),
  ...(attention(value.attention)
    ? { attention: { state: value.attention.state, trust: value.attention.trust, since: value.attention.since } }
    : {}) };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/communicationSnapshot.test.ts`
Expected: PASS — new tests plus all pre-existing tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/shared/communicationSnapshot.ts src/shared/communicationSnapshot.test.ts
git commit -m "feat(communication): project attention across the renderer boundary"
```

---

### Task 6: Wire the evidence in main

**Files:**
- Modify: `electron/communicationBridge/mainIntegration.ts` (constructor options, `snapshot()` at 63-72)
- Modify: `electron/main.ts:1051-1053` (the bridge `spawn` callback)
- Modify: `electron/communicationBridge/mainIntegration.test.ts` (append)

**Interfaces:**
- Consumes: `createTrustAttention` (Task 3), `createTrustPromptMatcher` (Task 1), `readLaunchTrust` (Task 4), `PreparedBridgeLaunch.completion()`.
- Produces: two new `CommunicationBridgeOptions` fields and two new public methods:

```ts
// on CommunicationBridgeOptions
attention?: {
  update(inputs: TrustAttentionInputs): Attention | undefined;
  nextDeadline(inputs: TrustAttentionInputs): number | null;
};
evidence?: () => Pick<TrustAttentionInputs,
  'trustedAtLaunch' | 'promptSeenAt' | 'promptActive' | 'completion' | 'spawnedAt'>;

// on CommunicationBridgeIntegration
attentionDeadline(): number | null;
refreshAttention(): void;
```

Launch evidence is owned by `main.ts`, not by the bridge. The `prepare` and `spawn` callbacks that already live there are where the trust precheck, the spawn timestamp, and `completion()` naturally land, so the bridge stays about pipes and launches and takes a plain `evidence` callback. Both are injected, so `mainIntegration.test.ts` drives them with no pty and no fs.

`GRACE` and `STALL` elapse with no event, so `main.ts` schedules one timer from `attentionDeadline()`. The timer calls `refreshAttention()`, which emits; the emit runs `onSnapshot`, which reschedules. The loop terminates on its own when `nextDeadline()` returns `null`.

**`clientAlive` is deliberately absent.** `spawnPty` runs `powershell.exe -NoExit`, so the pty outlives the CLI and `terminalAlive` tracks the shell. Use `completion()`, which is backed by `started.json` and the `completed` file the launch script writes.

- [ ] **Step 1: Write the failing test**

```ts
it('surfaces attention on the snapshot without touching readiness', async () => {
  const attention = {
    update: () => ({ state: 'blocked' as const, trust: 'unaccepted' as const, since: 7 }),
    nextDeadline: () => null,
  };
  const bridge = new CommunicationBridgeIntegration({ attention });
  await bridge.setEnabled(true);
  const snapshot = bridge.snapshot();
  expect(snapshot.attention).toEqual({ state: 'blocked', trust: 'unaccepted', since: 7 });
  expect(snapshot.readiness).toBe('disconnected');
});

it('omits attention entirely when the deriver reports none', async () => {
  const bridge = new CommunicationBridgeIntegration({
    attention: { update: () => undefined, nextDeadline: () => null },
  });
  await bridge.setEnabled(true);
  expect('attention' in bridge.snapshot()).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/communicationBridge/mainIntegration.test.ts -t attention`
Expected: FAIL — `attention` is `undefined` on the snapshot.

- [ ] **Step 3: Wire it into the bridge**

Add the imports at the top of `mainIntegration.ts`:

```ts
import type { Attention } from '../../src/shared/communicationTypes';
import type { TrustAttentionInputs } from './trustAttention';
```

Add the two fields to `CommunicationBridgeOptions`, exactly as given in the Interfaces block above.

`snapshot()` currently derives readiness inline inside its return object. `attentionDeadline()` needs the same value, so extract it into a private helper first — this is a pure extraction with no behaviour change:

```ts
private readinessNow(): CommunicationBridgeSnapshot['readiness'] {
  return !this.enabled ? 'disabled' : !this.current ? 'disconnected'
    : this.current.authenticated && this.current.listed ? 'ready'
      : this.current.authenticated ? 'authenticated' : 'waiting';
}

private deriveAttentionNow(): Attention | undefined {
  const evidence = this.options.evidence?.();
  if (!evidence || !this.options.attention) return undefined;
  return this.options.attention.update({
    launchId: this.current?.id ?? null, readiness: this.readinessNow(), now: Date.now(), ...evidence });
}
```

Then `snapshot()` becomes — every existing field computed exactly as before, with `readiness` now coming from the helper and one spread appended:

```ts
snapshot(): CommunicationBridgeSnapshot {
  const metadata = this.controller.metadata();
  const controllerCleanup = this.controller.cleanupStatus();
  if (controllerCleanup === 'failed') this.cleanup = 'failed';
  const attention = this.deriveAttentionNow();
  return { enabled: this.enabled,
    readiness: this.readinessNow(),
    cleanup: this.cleanup === 'failed' ? 'failed'
      : this.cleanup === 'pending' || this.closing.size > 0 || controllerCleanup === 'pending' ? 'pending' : 'confirmed',
    metadata, ...(this.current ? { remainingCredits: this.controller.remainingCredits() } : {}),
    ...(attention ? { attention } : {}) };
}
```

Add the two public methods beside it:

```ts
/** Absolute ms of the next instant at which attention could change, for the caller's timer. */
attentionDeadline(): number | null {
  const evidence = this.options.evidence?.();
  if (!evidence || !this.options.attention) return null;
  return this.options.attention.nextDeadline({
    launchId: this.current?.id ?? null, readiness: this.readinessNow(), now: Date.now(), ...evidence });
}

/** Re-emit so a threshold crossing reaches the renderer. Nothing else produces an
 * event when GRACE or STALL simply elapses. */
refreshAttention(): void { this.emit(); }
```

- [ ] **Step 4: Track launch evidence in main**

In `electron/main.ts`, add these declarations **before** the bridge construction at line 84, so the `evidence` closure never reads an uninitialised binding:

```ts
const trustPromptMatcher = createTrustPromptMatcher();
let connectedTrust: true | false | 'unknown' = 'unknown';
let connectedSpawnedAt: number | null = null;
let connectedCompletion: LaunchCompletion = 'starting';
```

Imports to add: `createTrustPromptMatcher` from `./communicationBridge/trustPromptMatcher`, `createTrustAttention` and `type LaunchCompletion` from `./communicationBridge/trustAttention`, `readLaunchTrust` from `./communicationBridge/launchConfig`, and `homedir` from `node:os` if it is not already imported.

Extend the bridge construction at lines 84-86:

```ts
const communicationBridge = new CommunicationBridgeIntegration({
  onSnapshot: snapshot => { sendToWindow('communication:snapshot', snapshot); scheduleAttentionDeadline(); },
  attention: createTrustAttention(),
  evidence: () => {
    const prompt = trustPromptMatcher.state();
    return { trustedAtLaunch: connectedTrust, promptSeenAt: prompt.seenAt, promptActive: prompt.active,
      completion: connectedCompletion, spawnedAt: connectedSpawnedAt };
  },
});

let attentionTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleAttentionDeadline(): void {
  if (attentionTimer) { clearTimeout(attentionTimer); attentionTimer = undefined; }
  const deadline = communicationBridge.attentionDeadline();
  if (deadline === null) return;
  attentionTimer = setTimeout(() => {
    attentionTimer = undefined;
    communicationBridge.refreshAttention();
  }, Math.max(0, deadline - Date.now()));
}
```

- [ ] **Step 5: Set the evidence at the real launch boundaries**

The launch cwd is `homedir()`, set in `launchConfig.ts:172`. Read trust against that same directory, in the existing `prepare` callback at line 1047:

```ts
prepare: async manifest => {
  connectedTrust = await readLaunchTrust(homedir());
  connectedSpawnedAt = null;
  connectedCompletion = 'starting';
  trustPromptMatcher.reset();
  const prepared = await prepareBridgeLaunch({ ...launchRuntime, manifest, root: launchRoot, executable: connectedExecutable });
  // completion() settles when the launch script's child actually ends. This is the
  // authoritative client lifecycle -- the pty runs powershell with -NoExit and
  // outlives the CLI, so pty liveness would report "running" through every exit.
  void prepared.completion().then(
    result => { connectedCompletion = result; communicationBridge.refreshAttention(); },
    () => { connectedCompletion = 'failed'; communicationBridge.refreshAttention(); });
  return prepared;
},
```

And in the existing `spawn` callback at lines 1050-1056:

```ts
spawn: (bundle, onExit) => {
  connectedSpawnedAt = Date.now();
  connectedCompletion = 'running';
  ptyLifecycle.start(() => spawnPty(100, 30, bundle), {
    onData: data => {
      sendToWindow('pty:data', data);
      planUsageScraper.ingest(data);
      // Refresh only when the prompt reading actually moved. A busy terminal fires
      // onData constantly, and an unconditional refresh here would push an IPC
      // snapshot per chunk -- the same trap planUsageScraper documents for its own
      // capturedAtMs stamping.
      const before = trustPromptMatcher.state();
      trustPromptMatcher.ingest(data);
      const after = trustPromptMatcher.state();
      if (before.seenAt !== after.seenAt || before.active !== after.active) communicationBridge.refreshAttention();
    },
    onAlive: () => sendToWindow('pty:alive', undefined),
    onExit: () => { onExit(); sendToWindow('pty:exit', undefined); planUsageScraper.reset(); },
  });
  liveAgentTracker.notifyPtySpawned(Date.now());
},
```

`trustPromptMatcher.reset()` belongs in `prepare`, not in the pty `onExit`. The exit diagnosis is derived from `promptSeenAt`, so clearing the latch on exit would erase the very evidence that explains the exit; the next launch clears it instead.

- [ ] **Step 6: Run the affected suites**

Run: `npx vitest run electron/communicationBridge/ && npm run typecheck:electron`
Expected: PASS, clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add electron/communicationBridge/mainIntegration.ts electron/communicationBridge/mainIntegration.test.ts electron/main.ts
git commit -m "feat(communication): feed trust evidence into the bridge snapshot"
```

---

### Task 7: Operator-facing copy

**Files:**
- Create: `src/components/settings/attentionCopy.ts`
- Create: `src/components/settings/attentionCopy.test.ts`
- Modify: `src/components/settings/CommunicationCard.tsx:114`
- Modify: `src/components/layout/CommunicationIndicator.tsx:21`
- Modify: `src/components/settings/CommunicationCard.test.tsx` (append)

**Interfaces:**
- Consumes: `Attention` from `src/shared/communicationTypes.ts`.
- Produces: `attentionCopy(attention: Attention): { readonly title: string; readonly detail: string; readonly canFocusTerminal: boolean }`.

Focus-terminal navigation is `dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Terminal' })`, with precedent for dispatching it outside the sidebar at `Sidebar.tsx:48-49`. Pair it with the `prepareClaudeTerminal()` the card already imports at line 6.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { attentionCopy } from './attentionCopy';
import type { Attention, AttentionState, AttentionTrust } from '../../shared/communicationTypes';

const make = (state: AttentionState, trust: AttentionTrust): Attention => ({ state, trust, since: 0 });

describe('attentionCopy', () => {
  it('names the required action when the prompt is confirmed on screen', () => {
    const copy = attentionCopy(make('blocked', 'prompt-seen'));
    expect(copy.title).toBe('Action required: folder trust');
    expect(copy.detail).toContain('The default choice exits the client.');
    expect(copy.canFocusTerminal).toBe(true);
  });

  it('states the config fact and hedges only the consequence when merely suspected', () => {
    const copy = attentionCopy(make('blocked', 'unaccepted'));
    expect(copy.detail).toContain("isn't in the client's trusted list");
  });

  it('never claims an untrusted folder when the config was unreadable', () => {
    const copy = attentionCopy(make('stalled', 'unknown'));
    expect(copy.detail).not.toContain('trusted list');
  });

  it('explains the destructive default after an exit at the prompt', () => {
    expect(attentionCopy(make('exited', 'prompt-seen')).detail).toContain('default choice exits');
  });

  it('offers no terminal focus once the client has exited', () => {
    expect(attentionCopy(make('exited', 'not-implicated')).canFocusTerminal).toBe(false);
  });

  it.each([
    ['blocked', 'prompt-seen'], ['blocked', 'unaccepted'],
    ['stalled', 'unaccepted'], ['stalled', 'prompt-seen'],
    ['stalled', 'unknown'], ['stalled', 'not-implicated'],
    ['exited', 'prompt-seen'], ['exited', 'unaccepted'],
    ['exited', 'unknown'], ['exited', 'not-implicated'],
  ] as const)('never tells the operator to press Enter: %s/%s', (state, trust) => {
    const copy = attentionCopy(make(state, trust));
    expect(`${copy.title} ${copy.detail}`).not.toMatch(/press enter|hit enter/i);
    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.detail.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/settings/attentionCopy.test.ts`
Expected: FAIL — cannot resolve `./attentionCopy`.

- [ ] **Step 3: Write the implementation**

```ts
import type { Attention } from '../../shared/communicationTypes';

export interface AttentionCopy {
  readonly title: string;
  readonly detail: string;
  readonly canFocusTerminal: boolean;
}

// Two rules hold across every line below. Nothing says "press Enter", because
// Enter selects "No, exit" on the trust prompt. And nothing tells the operator to
// trust the folder outright -- the launch cwd is their home directory, and copy
// that nudges someone into trusting all of it is the wrong default.
export function attentionCopy(attention: Attention): AttentionCopy {
  const focus = attention.state !== 'exited';
  if (attention.state === 'blocked') {
    return attention.trust === 'prompt-seen'
      ? { title: 'Action required: folder trust', canFocusTerminal: focus,
          detail: 'Review the folder-trust prompt in the terminal to continue. The default choice exits the client.' }
      : { title: 'Folder trust likely required', canFocusTerminal: focus,
          detail: "This folder isn't in the client's trusted list. Check the terminal for a trust prompt; the default choice exits the client." };
  }
  if (attention.state === 'stalled') {
    if (attention.trust === 'unaccepted') {
      return { title: "Client hasn't connected", canFocusTerminal: focus,
        detail: "It may still be waiting at a folder-trust prompt; this folder isn't in the client's trusted list. Check the terminal." };
    }
    if (attention.trust === 'prompt-seen') {
      return { title: "Client hasn't connected", canFocusTerminal: focus,
        detail: 'A folder-trust prompt was shown earlier. Check the terminal.' };
    }
    return { title: 'Client not ready — check terminal', canFocusTerminal: focus,
      detail: 'The client may be waiting for input, such as a folder-trust decision.' };
  }
  if (attention.trust === 'prompt-seen') {
    return { title: 'Client exited before connecting', canFocusTerminal: false,
      detail: 'A folder-trust prompt was shown, and its default choice exits. Start a fresh connected Claude, and review the folder before trusting it.' };
  }
  if (attention.trust === 'unaccepted') {
    return { title: 'Client exited before connecting', canFocusTerminal: false,
      detail: "This folder isn't in the client's trusted list, so a trust prompt was likely shown; its default choice exits." };
  }
  return { title: 'Client exited before connecting', canFocusTerminal: false,
    detail: 'Start a fresh connected Claude to retry.' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/settings/attentionCopy.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Render it in the settings card**

Replace the status line at `CommunicationCard.tsx:114`. Attention becomes the primary status; the raw readiness enum is demoted to secondary detail:

```tsx
{snapshot?.attention && (() => {
  const copy = attentionCopy(snapshot.attention);
  return <div role="alert" style={{ marginTop: 10 }}>
    <strong style={{ color: colors.textPrimary }}>{copy.title}</strong>
    <p style={{ margin: '4px 0 0' }}>{copy.detail}</p>
    {copy.canFocusTerminal && <Button onClick={() => {
      prepareClaudeTerminal();
      dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Terminal' });
    }} style={{ padding: '6px 10px', marginTop: 8, color: colors.textSecondary,
      border: `1px solid ${colors.panelBorder}`, borderRadius: 7 }}>Focus terminal</Button>}
  </div>;
})()}
<p role="status">Bridge: {snapshot ? snapshot.readiness : 'status unavailable'}.
  {snapshot && ` Cleanup: ${snapshot.cleanup}.`}</p>
```

Import `attentionCopy` at the top of the file.

- [ ] **Step 6: Render it in the global indicator**

At `CommunicationIndicator.tsx:21`, the always-visible surface must reflect attention too — Settings is usually closed, so a Settings-only fix leaves the reported problem in place. Add the import first:

```ts
import { attentionCopy } from '../settings/attentionCopy';
```


```ts
detail: snapshot
  ? (snapshot.attention ? attentionCopy(snapshot.attention).title : `Bridge ${snapshot.readiness}`)
  : 'Status unavailable',
```

- [ ] **Step 7: Run the full suite**

Run: `npm test && npm run typecheck:electron`
Expected: PASS — 1,691 pre-existing tests plus the ~45 added by this plan.

- [ ] **Step 8: Commit**

```bash
git add src/components/settings/attentionCopy.ts src/components/settings/attentionCopy.test.ts src/components/settings/CommunicationCard.tsx src/components/settings/CommunicationCard.test.tsx src/components/layout/CommunicationIndicator.tsx
git commit -m "feat(communication): tell the operator when the client needs a trust decision"
```

---

## Calibration follow-up

`TRUST_STALL_MS` ships provisional. Once a connected launch reaches `ready` end to end on a trusted folder, measure the spawn-to-`ready` interval and tighten the constant if 20 s is far above it. Do not tighten it below an observed healthy handshake — a nagging stall banner is worse than a late one.

`TRUST_GRACE_MS` matters less than it looks: the real capture shows the prompt renders at 562 ms, so the matcher normally reaches `confirmed` long before the grace window elapses. Grace only covers the case where the matcher misses.
