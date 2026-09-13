# Folder-Trust Recognition Implementation Plan (cross-check Tasks 3-6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the operator when the connected Claude client is blocked on the folder-trust prompt, stalled, or exited — instead of showing a bare `Bridge: waiting.` that means all three.

**Architecture:** Continues the existing cross-check sequence rather than forking it. Task 2 (`a0a4a85`) already shipped `sessionStatus` with a `prompt` field and the main-only `observePrompt()` seam, explicitly noting *"No detector is wired yet"*. This plan supplies that detector (Task 3), wires it (Task 4), adds positive client-exit evidence (Task 5), and derives operator copy from those facts (Task 6).

**Tech Stack:** TypeScript, Electron main/renderer split, Vitest, React.

**Spec:** `docs/superpowers/specs/2026-09-12-folder-trust-attention-design.md`

**Predecessors:** `docs/superpowers/plans/2026-09-12-cross-check-task1-results.md`, `docs/superpowers/plans/2026-09-12-cross-check-task2-results.md`

## Rebase note

This plan replaces an earlier draft that added a parallel `attention` snapshot field and its own detector seam. That draft was written before `a0a4a85` landed and would have produced two competing representations of the same fact. Two consequences:

- **No `attention` field is added.** `sessionStatus` is extended instead, staying the single representation. It remains facts-only, matching its `/** Display-only runtime state. */` contract.
- **Presentation is derived in the renderer** from those facts plus a clock, not precomputed in main. This overrides the earlier shape decision (`{kind, confidence, since}` in main) as a direct consequence of adopting `sessionStatus`. The derive function still takes `now` as a parameter and stays pure, so it is exactly as testable; only the re-render tick is new.

Task numbering follows the next-task statements in the two results docs above. If the canonical cross-check list numbers these differently, confirm the mapping before starting.

## Global Constraints

- Worktree `.worktrees/visible-communication-u1`, branch `feat/visible-communication-u1`. Base: `5be71ab`. Run all commands from that directory.
- Tests: `npx vitest run <path>` for one file, `npm test` for the full suite. **Baseline is 1,732 passing, 7 skipped** (per the Task 2 results doc).
- Also required before any task is called done: `npm run typecheck:electron` and `npm run build`.
- Interfaces in `src/shared/` use `readonly` members.
- **Task 3's stated bound: no selected-option parsing, no automatic terminal input.** The matcher recognises that the prompt is present. It must never read which option the `❯` marker sits on, and nothing in this plan ever writes to the pty.
- **No copy anywhere may say "press Enter".** Enter selects "No, exit" — the destructive default.
- **No copy may tell the operator to trust the folder outright.** Direct them to review it first.
- `trustedAtLaunch: 'unknown'` means the config was unreadable. It must never render as "not in the trusted list".
- Out of scope: changing the launch cwd (`ptyManager.ts:58`, `launchConfig.ts:172`), and writing `hasTrustDialogAccepted` on the operator's behalf.
- `stripAnsi` deletes CSI cursor-forward sequences. Prompt words arrive separated by `ESC[1C`, so stripped text reads `Yes,Itrustthisfolder`. **Every inter-word gap in a prompt regex must be `\s*`, never a literal space.**

---

### Task 3: Bounded current-prompt recognition

**Status: Passed, 2026-09-12.** See `2026-09-12-cross-check-task3-results.md`
for results, independent review, fixture provenance, and limits.

Implemented `trustPromptMatcher.ts` and its 42-test suite; sanitized the capture
with equal-length placeholders while preserving all eight chunk timestamps and
control sequences. No runtime wiring or model call belongs to this task.

The original append-only two-option sample was superseded: silence cannot prove
current presence, printable output may be a repaint, and stripping screen erase
commands preserves stale text. The implementation uses a bounded current-screen
model and matches the full captured layout. The shared `ansiStrip` is unchanged;
it already handles complete BEL/ST OSC strings, whereas the detector needs
streaming control handling across chunks.

Contract: `createTrustPromptMatcher(now?, {rows, cols}?)`, default100x30 with
maximum160x32, returns `ingest`, `state`, `resize(cols, rows)`, and `reset`.
`state()` exposes only `{seenAt, active}`; history is not current readiness/exit
proof. Task4 must supply actual physical dimensions and forward resize before
further bytes. Resize clears pixels/current evidence and preserves history and
persistent-mode uncertainty. Full reset is valid only for a fresh physical session.

Known screen erasure/scrolling can be followed by a fresh recognized redraw.
Unsupported persistent modes, conceal, or malformed controls require fresh-session
reset; CSI2J and resize cannot restore that evidence. CSI3J only erases scrollback.
OSC metadata is opaque, cancellation is handled, and synchronized output cannot
be considered visible before flush. Unsupported wrapping, glyphs, geometry, or
layouts fail conservatively. No selected-option parsing or terminal input is added.

- [x] Implement bounded recognition and sanitized capture regression.
- [x] Verify capture at every split point and one-character delivery.
- [x] Verify stale/erased/overwritten text, OSC spoofing, cancellation, conceal,
      modes, geometry, right-margin behavior, synchronization, reset, and bounds.
- [x] Run full unit suite (1774 passed,7 skipped), build, Electron typecheck.
- [x] Independent final review:42 focused tests +13 adversarial probes Passed.

---
### Task 4: Wire recognition to the existing observePrompt seam

Implemented as a physical-PTY and launch-scoped `ConnectedPromptObserver`; see `2026-09-12-cross-check-task4-results.md` for final verification and limitations.

Files: `electron/communicationBridge/connectedPromptObserver.ts`, `electron/main.ts`, `electron/communicationBridge/mainIntegration.ts` (comment only), and `electron/ptyLifecycle.consumers.test.ts`.

The previous sample used a global matcher reset during launch preparation and looked up the current launch ID when each chunk arrived. That sample is superseded: preparation is not a physical terminal transition, and incoming bytes must retain their original owner. A fresh matcher belongs to each newly spawned physical PTY and captured launch ID. Every observation requires both owners to remain current. Replacement invalidates observer ownership before the outgoing PTY can emit synchronous callbacks; failed replacement cannot attribute surviving old output to a new launch.

Map positive recognition to `folder-trust` and every other result to `unknown`. No confirmed-absent state or readiness/exit conclusion follows from false. Retain the existing bridge seam's launch validation and change-only snapshot emission. Do not expose or persist raw matcher text.

Use actual physical spawn dimensions (currently100x30), then invalidate evidence and forward each resize. Positive publication waits for successful native resize return and a fresh ownership check. A native resize failure or nested same-owner resize leaves dimensions uncertain until an independent successful resize. A replacement owner is unaffected by an outgoing resize. Resize never resets persistent mode uncertainty. The shared PTY lifecycle ordering and ordinary Claude/Codex behavior remain unchanged.

Verification executes the actual main spawn/resize callbacks with deterministic fake PTYs and includes replacement, revocation, old callbacks, failed spawn/cleanup/resize, unsupported dimensions, persistent uncertainty, unfinished controls, synchronized output, and clear/repaint. Build the Electron bundle now that the matcher is a runtime dependency. Native plumbing smokes use harmless CLI fixtures and do not prove a live connected-client prompt.

Task 5 retains responsibility for positive client-exit evidence and actionable copy; it must not infer exit from prompt disappearance or helper disconnection.

---
### Task 5: Positive client-exit evidence

**Files:**
- Modify: `src/shared/communicationSessionStatus.ts`
- Modify: `src/shared/communicationSessionStatus.test.ts` (append; create if absent)
- Modify: `electron/communicationBridge/launchConfig.ts` (add an export; reuses the private `jsonFile` helper at line 37)
- Modify: `electron/communicationBridge/launchConfig.test.ts` (append)
- Modify: `electron/communicationBridge/mainIntegration.ts` (`Launch` interface, `snapshot()`, one new observation method)
- Modify: `electron/communicationBridge/mainIntegration.test.ts` (append)
- Modify: `electron/main.ts` (the `prepare` and `spawn` callbacks)

**Interfaces:**
- Produces: `readLaunchTrust(directory: string): Promise<true | false | 'unknown'>` from `launchConfig.ts`; `CommunicationBridgeIntegration.observeLaunch(launchId, evidence)`; four new `CommunicationSessionStatus` fields.

The Task 2 results doc states this task's requirement directly: *"Task 5 must obtain positive client-exit evidence rather than interpreting disconnected readiness as Client exited."*

**The pty cannot supply that evidence.** `spawnPty` runs `powershell.exe -NoExit -File launch.ps1`, so the shell deliberately outlives the CLI and `terminalAlive` tracks PowerShell, not `claude.exe`. The authoritative signal is `PreparedBridgeLaunch.completion()`, backed by `started.json` (child PID via `Start-Process -PassThru`) and the `completed` file (`exited` | `failed`) that `BRIDGE_LAUNCH_SCRIPT` writes in its `finally` block.

- [ ] **Step 1: Write the failing contract test**

```ts
import { describe, expect, it } from 'vitest';
import { projectCommunicationSessionStatus } from './communicationSessionStatus';

const valid = {
  instanceLabel: 'Instance 0123456789abcdef', sessionLabel: 'Session 1',
  prompt: 'folder-trust', promptSeen: true, lifecycle: 'running',
  trustedAtLaunch: false, spawnedAt: 5,
};

describe('session status with launch evidence', () => {
  it('carries the new evidence fields through', () => {
    expect(projectCommunicationSessionStatus(valid)).toEqual(valid);
  });

  it.each([
    ['bad lifecycle', { ...valid, lifecycle: 'nope' }],
    ['bad trustedAtLaunch', { ...valid, trustedAtLaunch: 'maybe' }],
    ['non-boolean promptSeen', { ...valid, promptSeen: 'yes' }],
    ['negative spawnedAt', { ...valid, spawnedAt: -1 }],
  ])('rejects %s', (_label, input) => {
    expect(projectCommunicationSessionStatus(input)).toBeNull();
  });

  it('rejects evidence claimed with no active launch', () => {
    expect(projectCommunicationSessionStatus({
      ...valid, sessionLabel: null, prompt: 'unknown', promptSeen: true,
      lifecycle: 'starting', spawnedAt: null })).toBeNull();
  });

  it('accepts a launch that has not spawned yet', () => {
    expect(projectCommunicationSessionStatus({
      ...valid, prompt: 'unknown', promptSeen: false, lifecycle: 'starting', spawnedAt: null,
    })).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/communicationSessionStatus.test.ts`
Expected: FAIL — the new fields are stripped, so the first test's `toEqual` mismatches.

- [ ] **Step 3: Extend the contract**

In `src/shared/communicationSessionStatus.ts`:

```ts
export type ClientLifecycle = 'starting' | 'running' | 'exited' | 'failed';

export interface CommunicationSessionStatus {
  readonly instanceLabel: string;
  readonly sessionLabel: string | null;
  /** Positive current-prompt evidence only; unknown does not mean input-ready. */
  readonly prompt: 'unknown' | 'folder-trust';
  /** History, not current state: the prompt appeared at some point this launch.
   * Exit attribution needs it, because `prompt` clears the moment it is answered. */
  readonly promptSeen: boolean;
  /** Positive client lifecycle from the launch script's own child tracking. The pty
   * runs powershell with -NoExit and outlives the CLI, so pty liveness cannot
   * supply this. */
  readonly lifecycle: ClientLifecycle;
  /** Deterministic pre-launch config read. 'unknown' means the config was
   * unreadable and must never be rendered as "not in the trusted list". */
  readonly trustedAtLaunch: true | false | 'unknown';
  /** Client spawn time, for elapsed-based stall reporting. Null before spawn. */
  readonly spawnedAt: number | null;
}

export function isClientLifecycle(value: unknown): value is ClientLifecycle {
  return value === 'starting' || value === 'running' || value === 'exited' || value === 'failed';
}
```

Extend `projectCommunicationSessionStatus` with the same allowlist discipline it already uses, keeping the existing checks and adding:

```ts
if (typeof raw.promptSeen !== 'boolean' || !isClientLifecycle(raw.lifecycle)
  || !(raw.trustedAtLaunch === true || raw.trustedAtLaunch === false || raw.trustedAtLaunch === 'unknown')
  || !(raw.spawnedAt === null
    || (typeof raw.spawnedAt === 'number' && Number.isSafeInteger(raw.spawnedAt) && raw.spawnedAt >= 0))) return null;
// No launch means no evidence, matching the existing sessionLabel/prompt invariant.
if (raw.sessionLabel === null && (raw.promptSeen || raw.lifecycle !== 'starting' || raw.spawnedAt !== null)) return null;
```

and copy the four new fields in the return.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/communicationSessionStatus.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the trust precheck**

Add to `electron/communicationBridge/launchConfig.ts`. Trust keys are stored forward-slashed (`C:/Users/Matt`) while `homedir()` is backslashed, so both sides go through `resolve()` + lowercase — the normalization `checkPolicy` already uses at line 82:

```ts
/** Deterministic pre-launch evidence: does the client already trust this folder?
 * An absent entry means it has never been trusted, which is a real `false`. Only an
 * unreadable or malformed config yields 'unknown'. */
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

Test it in `launchConfig.test.ts`:

```ts
import { homedir, tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readLaunchTrust } from './launchConfig';

describe('readLaunchTrust', () => {
  it('returns false for a directory with no entry at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trust-precheck-'));
    try { expect(await readLaunchTrust(dir)).toBe(false); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('never guesses for the real home directory', async () => {
    expect([true, false, 'unknown']).toContain(await readLaunchTrust(homedir()));
  });
});
```

- [ ] **Step 6: Carry the evidence on the launch**

In `mainIntegration.ts`, extend the `Launch` interface and mirror the fields into `snapshot()`'s `sessionStatus`, defaulting a new launch to `promptSeen: false`, `lifecycle: 'starting'`, `trustedAtLaunch: 'unknown'`, `spawnedAt: null`. Set `promptSeen` to `true` inside the existing `observePrompt` whenever it accepts a `'folder-trust'` value, and add the sibling observation method next to it:

`Launch` is module-private, so a public method must not reference it through `Pick` — that breaks declaration emit. Export an explicit shape beside `CommunicationBridgeSnapshot`:

```ts
export interface LaunchEvidence {
  readonly lifecycle?: ClientLifecycle;
  readonly trustedAtLaunch?: true | false | 'unknown';
  readonly spawnedAt?: number | null;
}
```

```ts
/** Main-only observation seam, same authority rules as observePrompt: labels and
 * evidence never grant capability, and stale launches are rejected. */
observeLaunch(launchId: string, evidence: LaunchEvidence): boolean {
  const launch = this.current;
  if (!this.enabled || this.disposed || !launch?.valid || launch.id !== launchId) return false;
  let changed = false;
  for (const key of ['lifecycle', 'trustedAtLaunch', 'spawnedAt'] as const) {
    const next = evidence[key];
    if (next !== undefined && launch[key] !== next) { (launch as Record<string, unknown>)[key] = next; changed = true; }
  }
  if (changed) this.emit();
  return true;
}
```

- [ ] **Step 7: Feed it from the launch boundaries**

In `electron/main.ts`, the launch cwd is `homedir()` (set in `launchConfig.ts:172`), so read trust against that same directory:

```ts
prepare: async manifest => {
  trustPromptMatcher.reset();
  const prepared = await prepareBridgeLaunch({ ...launchRuntime, manifest, root: launchRoot, executable: connectedExecutable });
  const launchId = communicationBridge.currentLaunchId();
  if (launchId) {
    void readLaunchTrust(homedir()).then(trustedAtLaunch =>
      communicationBridge.observeLaunch(launchId, { trustedAtLaunch }));
    // completion() settles when the launch script's own child ends -- the positive
    // exit evidence this task requires.
    void prepared.completion().then(
      lifecycle => communicationBridge.observeLaunch(launchId, { lifecycle }),
      () => communicationBridge.observeLaunch(launchId, { lifecycle: 'failed' }));
  }
  return prepared;
},
```

and in `spawn`, before `ptyLifecycle.start(...)`:

```ts
const launchId = communicationBridge.currentLaunchId();
if (launchId) communicationBridge.observeLaunch(launchId, { lifecycle: 'running', spawnedAt: Date.now() });
```

Import `readLaunchTrust` from `./communicationBridge/launchConfig` and `homedir` from `node:os` if not already imported.

- [ ] **Step 8: Run the affected suites**

Run: `npx vitest run src/shared/ electron/communicationBridge/ && npm run typecheck:electron`
Expected: PASS, clean typecheck.

- [ ] **Step 9: Commit**

```bash
git add src/shared/communicationSessionStatus.ts src/shared/communicationSessionStatus.test.ts electron/communicationBridge/launchConfig.ts electron/communicationBridge/launchConfig.test.ts electron/communicationBridge/mainIntegration.ts electron/communicationBridge/mainIntegration.test.ts electron/main.ts
git commit -m "feat(communication): obtain positive client-exit and trust evidence"
```

---

### Task 6: Operator-facing copy

**Files:**
- Create: `src/components/settings/attentionCopy.ts`
- Create: `src/components/settings/attentionCopy.test.ts`
- Modify: `src/components/settings/CommunicationCard.tsx` (the status line, now below the Task 2 identity block)
- Modify: `src/components/layout/CommunicationIndicator.tsx:21`
- Modify: `src/components/settings/CommunicationCard.test.tsx` (append)

**Interfaces:**
- Consumes: `CommunicationSessionStatus` (Task 5); `CommunicationBridgeSnapshot['readiness']`.
- Produces: `deriveAttention(status, readiness, now)` and `attentionCopy(attention)`.

Pure derivation, clock injected. `STALL_MS` is provisional: the capture shows the prompt renders at 562 ms, but there is no measured healthy-handshake baseline yet, so 20 s is deliberately generous — a nagging stall banner is worse than a late one.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { attentionCopy, deriveAttention, STALL_MS } from './attentionCopy';
import type { CommunicationSessionStatus } from '../../shared/communicationSessionStatus';

const base: CommunicationSessionStatus = {
  instanceLabel: 'Instance 0123456789abcdef', sessionLabel: 'Session 1',
  prompt: 'unknown', promptSeen: false, lifecycle: 'running',
  trustedAtLaunch: true, spawnedAt: 0,
};
const s = (over: Partial<CommunicationSessionStatus>) => ({ ...base, ...over });

describe('deriveAttention', () => {
  it('reports nothing during a healthy early wait', () => {
    expect(deriveAttention(s({}), 'waiting', 500)).toBeUndefined();
  });

  it('reports nothing once readiness reaches ready', () => {
    expect(deriveAttention(s({}), 'ready', STALL_MS)).toBeUndefined();
  });

  it('blocks while the prompt is currently on screen', () => {
    expect(deriveAttention(s({ prompt: 'folder-trust', promptSeen: true }), 'waiting', 600))
      .toEqual({ state: 'blocked', trust: 'prompt-seen' });
  });

  it('suspects folder trust from the precheck alone', () => {
    expect(deriveAttention(s({ trustedAtLaunch: false }), 'waiting', 4000))
      .toEqual({ state: 'blocked', trust: 'unaccepted' });
  });

  it('does not suspect folder trust when the config was unreadable', () => {
    expect(deriveAttention(s({ trustedAtLaunch: 'unknown' }), 'waiting', 4000)).toBeUndefined();
  });

  it('escalates to stalled while keeping the trust evidence', () => {
    expect(deriveAttention(s({ trustedAtLaunch: false }), 'waiting', STALL_MS))
      .toEqual({ state: 'stalled', trust: 'unaccepted' });
  });

  it('covers a stall at authenticated, not just waiting', () => {
    expect(deriveAttention(s({}), 'authenticated', STALL_MS))
      .toEqual({ state: 'stalled', trust: 'not-implicated' });
  });

  it('reports an exit at any readiness, including disconnected', () => {
    expect(deriveAttention(s({ lifecycle: 'exited' }), 'disconnected', 600))
      .toEqual({ state: 'exited', trust: 'not-implicated' });
  });

  it('attributes an exit to the prompt when the prompt was seen', () => {
    expect(deriveAttention(s({ lifecycle: 'exited', promptSeen: true }), 'disconnected', 600))
      .toEqual({ state: 'exited', trust: 'prompt-seen' });
  });

  it('never claims an exit before the client spawned', () => {
    expect(deriveAttention(s({ sessionLabel: null, lifecycle: 'starting', spawnedAt: null }), 'waiting', 60_000))
      .toBeUndefined();
  });

  it('keeps an active prompt blocked however long it waits', () => {
    expect(deriveAttention(s({ prompt: 'folder-trust', promptSeen: true }), 'waiting', 10 * STALL_MS))
      .toEqual({ state: 'blocked', trust: 'prompt-seen' });
  });
});

describe('attentionCopy', () => {
  it('names the required action when the prompt is on screen', () => {
    const copy = attentionCopy({ state: 'blocked', trust: 'prompt-seen' });
    expect(copy.title).toBe('Action required: folder trust');
    expect(copy.detail).toContain('The default choice exits the client.');
    expect(copy.canFocusTerminal).toBe(true);
  });

  it('states the config fact and hedges only the consequence', () => {
    expect(attentionCopy({ state: 'blocked', trust: 'unaccepted' }).detail)
      .toContain("isn't in the client's trusted list");
  });

  it('never claims an untrusted folder when the config was unreadable', () => {
    expect(attentionCopy({ state: 'stalled', trust: 'unknown' }).detail).not.toContain('trusted list');
  });

  it('offers no terminal focus once the client has exited', () => {
    expect(attentionCopy({ state: 'exited', trust: 'not-implicated' }).canFocusTerminal).toBe(false);
  });

  it.each([
    ['blocked', 'prompt-seen'], ['blocked', 'unaccepted'],
    ['stalled', 'unaccepted'], ['stalled', 'prompt-seen'],
    ['stalled', 'unknown'], ['stalled', 'not-implicated'],
    ['exited', 'prompt-seen'], ['exited', 'unaccepted'],
    ['exited', 'unknown'], ['exited', 'not-implicated'],
  ] as const)('never tells the operator to press Enter: %s/%s', (state, trust) => {
    const copy = attentionCopy({ state, trust });
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
import type { CommunicationBridgeSnapshot } from '../../../electron/communicationBridge/mainIntegration';
import type { CommunicationSessionStatus } from '../../shared/communicationSessionStatus';

export const GRACE_MS = 3_000;
export const STALL_MS = 20_000;

export type AttentionState = 'blocked' | 'exited' | 'stalled';
export type AttentionTrust = 'unaccepted' | 'prompt-seen' | 'unknown' | 'not-implicated';
export interface Attention { readonly state: AttentionState; readonly trust: AttentionTrust }

function trustEvidence(status: CommunicationSessionStatus): AttentionTrust {
  if (status.promptSeen) return 'prompt-seen';
  if (status.trustedAtLaunch === false) return 'unaccepted';
  if (status.trustedAtLaunch === 'unknown') return 'unknown';
  return 'not-implicated';
}

/** An exit is reportable at ANY readiness -- readiness falls to 'disconnected' on
 * teardown, and gating on 'waiting' would erase the diagnosis exactly when it
 * matters. Every other rule applies only while the client could still connect. */
export function deriveAttention(status: CommunicationSessionStatus,
  readiness: CommunicationBridgeSnapshot['readiness'], now: number): Attention | undefined {
  if (status.sessionLabel === null) return undefined;
  if (status.lifecycle === 'exited' || status.lifecycle === 'failed') {
    return { state: 'exited', trust: trustEvidence(status) };
  }
  if (status.lifecycle === 'starting' || status.spawnedAt === null) return undefined;
  if (readiness !== 'waiting' && readiness !== 'authenticated') return undefined;
  if (status.prompt === 'folder-trust') return { state: 'blocked', trust: 'prompt-seen' };
  const elapsed = now - status.spawnedAt;
  // STALL is checked before GRACE on purpose. Both can be true at once; the stall
  // reading must win so a long wait escalates to "this is not connecting" instead of
  // repeating "likely folder trust" forever. Trust evidence is retained either way.
  if (elapsed >= STALL_MS) return { state: 'stalled', trust: trustEvidence(status) };
  if (status.trustedAtLaunch === false && elapsed >= GRACE_MS) return { state: 'blocked', trust: 'unaccepted' };
  return undefined;
}

export interface AttentionCopy {
  readonly title: string;
  readonly detail: string;
  readonly canFocusTerminal: boolean;
}

// Two rules hold across every line below. Nothing says "press Enter", because Enter
// selects "No, exit" on the trust prompt. And nothing tells the operator to trust the
// folder outright -- the launch cwd is their home directory, and copy that nudges
// someone into trusting all of it is the wrong default.
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

- [ ] **Step 5: Add the threshold tick**

`GRACE_MS` and `STALL_MS` elapse with no event, so a component showing this must re-render at the crossing. Create `src/components/settings/useAttentionTick.ts`:

```ts
import { useEffect, useState } from 'react';
import { GRACE_MS, STALL_MS } from './attentionCopy';

/** Re-render at the next threshold crossing. Nothing else produces an event when
 * GRACE or STALL simply elapses. */
export function useAttentionTick(spawnedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (spawnedAt === null) return;
    const next = [spawnedAt + GRACE_MS, spawnedAt + STALL_MS].find(deadline => deadline > Date.now());
    if (next === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), next - Date.now());
    return () => clearTimeout(timer);
  }, [spawnedAt, now]);
  return now;
}
```

- [ ] **Step 6: Render it in the settings card**

In `CommunicationCard.tsx`, above the existing `<p role="status">Bridge: ...` line (which stays, demoted to secondary detail). Import `attentionCopy`, `deriveAttention`, and `useAttentionTick`; `dispatch` is already in scope at line 35 and `prepareClaudeTerminal` is already imported at line 6:

```tsx
const now = useAttentionTick(snapshot?.sessionStatus.spawnedAt ?? null);
const attention = snapshot && deriveAttention(snapshot.sessionStatus, snapshot.readiness, now);
```

```tsx
{attention && (() => {
  const copy = attentionCopy(attention);
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
```

`SET_ACTIVE_TAB` with `tab: 'Terminal'` is the navigation action; `Sidebar.tsx:48-49` is the precedent for dispatching it from outside the sidebar.

- [ ] **Step 7: Render it in the global indicator**

Settings is usually closed, so a Settings-only fix leaves the reported problem in place. At `CommunicationIndicator.tsx:21`, add `import { attentionCopy, deriveAttention } from '../settings/attentionCopy';` and:

```ts
detail: snapshot
  ? (() => {
      const attention = deriveAttention(snapshot.sessionStatus, snapshot.readiness, Date.now());
      return attention ? attentionCopy(attention).title : `Bridge ${snapshot.readiness}`;
    })()
  : 'Status unavailable',
```

- [ ] **Step 8: Run the full verification set**

Run: `npm test && npm run typecheck:electron && npm run build`
Expected: PASS — the 1,732-test baseline plus roughly 40 added by this plan; both checks exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/components/settings/attentionCopy.ts src/components/settings/attentionCopy.test.ts src/components/settings/useAttentionTick.ts src/components/settings/CommunicationCard.tsx src/components/settings/CommunicationCard.test.tsx src/components/layout/CommunicationIndicator.tsx
git commit -m "feat(communication): tell the operator when the client needs a trust decision"
```

---

## Calibration follow-up

`STALL_MS` ships provisional. Once a connected launch reaches `ready` end to end on a trusted folder, measure spawn-to-`ready` and tighten it if 20 s is far above that. Never tighten below an observed healthy handshake.

`GRACE_MS` matters less than it looks: the capture shows the prompt renders at 562 ms, so `prompt === 'folder-trust'` normally arrives long before the grace window elapses. Grace only covers the case where recognition misses.
