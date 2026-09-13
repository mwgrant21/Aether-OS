# Folder-trust attention in connected-launch readiness

Date: 2026-09-12
Branch: feat/visible-communication-u1

## Problem

Aether launches the Claude Code CLI in its embedded terminal and waits for that
session's stdio MCP helper to connect back over a named pipe. The Settings card
reports bridge readiness as a bare enum:

```
Bridge: waiting.
```

`waiting` means "launch prepared, pipe listening, helper has not authenticated".
It is also the normal healthy startup state, so it cannot distinguish *booting*
from *blocked on a prompt nobody told the operator about*.

The CLI launches with `workingDirectory: homedir()` (`launchConfig.ts:172`), and
on this machine `~/.claude.json` records
`projects["C:/Users/Matt"].hasTrustDialogAccepted: false`. The CLI therefore
blocks on a folder-trust prompt **whose default choice is exit**. The operator
sees `waiting` indefinitely, with no indication that input is required, and the
most likely keystroke kills the client.

This is not a first-run edge case. Every connected launch on an untrusted cwd
takes this path.

## Non-goals

- **Changing the launch cwd.** Deferred to its own design. It is set in two
  places (`ptyManager.ts:58` and `launchConfig.ts:172`), and it scopes the
  connected session's context, trust, and permission surface. It is *not* a
  read/write sandbox, and the deferred design must state its actual effects
  rather than imply containment.
- **Writing `hasTrustDialogAccepted` on the operator's behalf.** Aether must
  never accept a trust decision for the user.
- **Auto-answering or auto-dismissing the prompt.**

## Design

### Evidence

| Source | Kind | Where |
|---|---|---|
| `projects[cwd].hasTrustDialogAccepted` in `~/.claude.json` | deterministic, pre-launch | `checkPolicy()` already parses this file |
| The trust prompt observed in the PTY stream | observational | `main.ts:1052` already scrapes this stream |
| Launch completion | authoritative lifecycle | `PreparedBridgeLaunch.completion()` |
| Elapsed time | weak; never a cause on its own | — |

**PTY process liveness is not client liveness.** `spawnPty` runs
`powershell.exe -NoExit -File launch.ps1`, so the shell deliberately outlives
the CLI. `terminalAlive` tracks PowerShell. The authoritative signal is
`completion()`, backed by `started.json` (child PID) and the `completed` file
(`exited` | `failed`) written by `BRIDGE_LAUNCH_SCRIPT`.

### Module: `electron/communicationBridge/trustAttention.ts`

Pure, injected clock, no Electron / fs / pipe. Sits beside the existing
single-purpose modules (`grantControl.ts`, `quitGate.ts`, `sessionControl.ts`).

```ts
type AttentionState = 'blocked' | 'exited' | 'stalled';
type AttentionTrust = 'unaccepted' | 'prompt-seen' | 'unknown' | 'not-implicated';

interface Attention {
  state: AttentionState;   // lifecycle: what happened
  trust: AttentionTrust;   // evidence: what the trust config and PTY showed
  since: number;           // when this attention episode began
}

interface Inputs {
  launchId: string | null;              // scopes all state; a change resets everything
  readiness: CommunicationBridgeSnapshot['readiness'];
  trustedAtLaunch: true | false | 'unknown';   // 'unknown' = config unreadable
  promptSeenAt: number | null;          // history latch, per launch
  promptActive: boolean;                // see Open question 1
  completion: 'starting' | 'running' | 'exited' | 'failed';
  now: number;                          // monotonic
}
```

`state` and `trust` are independent on purpose. An exit can be certain while its
cause remains uncertain; a single `confidence` scalar cannot express that.

### Derivation

Rule 1 is evaluated whenever a launch exists, at any `readiness` — an exit must
be reportable even after readiness has fallen to `disconnected`. Rules 2 through
6 are evaluated only while `readiness` is `waiting` or `authenticated`.
`authenticated` is included because the helper can connect and then stall before
`tools/list`. First match wins.

| # | Condition | `state` | `trust` |
|---|---|---|---|
| 1 | `completion` is `exited` or `failed` | `exited` | derived (below) |
| 2 | `completion === 'starting'` | — | *(undefined; never claim an exit before spawn)* |
| 3 | `promptActive` | `blocked` | `prompt-seen` |
| 4 | `elapsed >= STALL` | `stalled` | derived |
| 5 | `trustedAtLaunch === false` and `elapsed >= GRACE` | `blocked` | `unaccepted` |
| 6 | otherwise | — | *(undefined)* |

Derived `trust`, in order: `prompt-seen` if `promptSeenAt !== null`, else
`unaccepted` if `trustedAtLaunch === false`, else `unknown` if
`trustedAtLaunch === 'unknown'`, else `not-implicated`.

`trustedAtLaunch === false` is required for trust-specific copy. `'unknown'`
must never render as "isn't in the trusted list" — an unreadable config is not
evidence of an untrusted folder.

Rule 4 precedes rule 5 deliberately. Because `STALL > GRACE`, the trust branch
fires first in time and the stall branch supersedes it later, so a long wait
escalates to "this isn't connecting" while retaining trust as the explanation.
Ordered the other way, the trust branch would win forever and the stall tier
would be unreachable.

### Latch and clearing

- `promptSeenAt` is a per-launch history latch. It is evidence for *attributing
  an exit*. It is **not** evidence the prompt is currently on screen — the
  operator may have answered it and the helper stalled afterwards. Rendering
  "action required" off the latch would tell someone to answer a prompt they
  already answered.
- `promptActive` is the separate, current-state signal (Open question 1).
- `since` is stamped when attention goes undefined to defined within a launch,
  preserved across every `state` and `trust` change in that episode, and cleared
  with the attention.
- `blocked` and `stalled` clear when `readiness` reaches `ready`.
- `exited` **persists** across readiness changes until a new launch or explicit
  dismissal. Clearing it on `disconnected` would erase the diagnosis at the
  moment it matters most. This falls out of rule 1 being readiness-independent:
  `exited` is re-derived on every evaluation for as long as the launch exists,
  not held as a stale value.

A prompt that stays genuinely active never escalates to `stalled` — rule 3
precedes rule 4, so "action required" remains correct for as long as the prompt
is actually on screen, however long that is.

### Deadlines

`GRACE` and `STALL` elapse with no event to ride on, so nothing would emit at
the crossing. The module exposes:

```ts
nextDeadline(): number | null   // earliest FUTURE instant at which output can change
```

`main.ts` schedules one timer against it and calls the bridge's existing
`emit()`. Comparisons are `>=`, elapsed time is monotonic, and only future
deadlines that can actually change the output are returned — scheduling exactly
`start + GRACE` against a `>` test can fire without transitioning and then
reschedule an already-past deadline.

Starting values `GRACE = 3s`, `STALL = 20s`, both to be calibrated (Open
question 2). Elapsed time starts at **spawn** (`started.json` written), not at
launch preparation.

### IPC

`Attention` is declared in `src/shared/communicationTypes.ts` beside
`CommunicationMetadata`. `CommunicationBridgeSnapshot` gains one optional
`attention` field. **The `readiness` union is not widened**, so every existing
consumer — including the `readiness !== 'ready'` gate in `grantControl.ts:12`
and the raw enum render in `CommunicationIndicator.tsx:21` — is untouched.

`projectCommunicationSnapshot` is a strict allowlist projector: it names every
field it copies and drops the rest, because "TypeScript types do not strip extra
IPC properties." A field added to the type and to `snapshot()` but not to the
projector type-checks cleanly and silently never reaches the renderer.

```ts
const attention = (v: unknown): v is Attention => object(v)
  && ['blocked', 'exited', 'stalled'].includes(v.state as string)
  && ['unaccepted', 'prompt-seen', 'unknown', 'not-implicated'].includes(v.trust as string)
  && count(v.since);
```

Malformed input rejects the whole snapshot, consistent with every other field.
The return copies field-by-field, mirroring the `remainingCredits` spread.

### Copy

Keyed on (`state`, `trust`). Nothing anywhere says "press Enter" — Enter is the
destructive default.

| state | trust | Copy |
|---|---|---|
| `blocked` | `prompt-seen` | **Action required: folder trust** — Review the folder-trust prompt in the terminal to continue. The default choice exits the client. *[Focus terminal]* |
| `blocked` | `unaccepted` | **Folder trust likely required** — This folder isn't in the client's trusted list. Check the terminal for a trust prompt; the default choice exits the client. *[Focus terminal]* |
| `stalled` | `unaccepted` | **Client hasn't connected** — It may still be waiting at a folder-trust prompt; this folder isn't in the client's trusted list. Check the terminal. *[Focus terminal]* |
| `stalled` | `prompt-seen` | **Client hasn't connected** — A folder-trust prompt was shown earlier. Check the terminal. *[Focus terminal]* |
| `stalled` | `unknown` / `not-implicated` | **Client not ready — check terminal** — The client may be waiting for input, such as a folder-trust decision. *[Focus terminal]* |
| `exited` | `prompt-seen` | **Client exited before connecting** — A folder-trust prompt was shown, and its default choice exits. Start a fresh connected Claude, and review the folder before trusting it. |
| `exited` | `unaccepted` | **Client exited before connecting** — This folder isn't in the client's trusted list, so a trust prompt was likely shown; its default choice exits. |
| `exited` | `unknown` / `not-implicated` | **Client exited before connecting** — Start a fresh connected Claude to retry. |

The `unaccepted` copy states the config fact and hedges only the consequence —
"isn't in the trusted list" is read from `~/.claude.json`, not inferred.

Copy never tells the operator to trust the folder outright. Trusting an entire
home directory is not a safe default to nudge someone toward.

Rendered in **both** surfaces: `CommunicationCard.tsx:114` (attention becomes
the primary status, raw readiness demoted to secondary detail) and
`CommunicationIndicator.tsx:21` (the always-visible indicator — Settings is
usually closed, so a Settings-only fix leaves the reported problem in place).

## Testing

`trustAttention.test.ts` — table-driven across the derivation matrix, plus:
`since` preserved across `state` and `trust` changes within an episode;
`promptSeenAt` latched but never rendering "action required" on its own;
`exited` surviving a readiness change to `disconnected`; `completion:'starting'`
never producing an exit; `launchId` change resetting latch, timestamps, and
deadline, and stale callbacks from a prior launch being ignored;
`nextDeadline()` returning only future, output-changing deadlines and `null`
when exhausted.

`communicationSnapshot.test.ts` — a real round trip, each malformed variant
rejecting the whole snapshot, and `attention` present then absent (does the
renderer actually clear?). Plus a guard test asserting every top-level key of a
fully-populated snapshot survives projection, to catch the next field that
forgets the projector.

`CommunicationCard.test.tsx` / indicator — one case per copy row on both
surfaces, and a literal assertion that rendered output never contains "press
Enter".

PTY matcher — fixture-driven against real captured output.

Integration — the deadline timer fires and produces an emit.

Full suite (1,691 tests on this branch) before done.

## Open questions

1. **How to distinguish "prompt currently active" from "prompt was seen".** The
   rolling buffer re-matches on every TUI repaint, so a match is not proof the
   prompt is still displayed. Resolved by the step-0 capture: if the CLI is
   quiet while blocked, output recency discriminates; if it repaints, a
   screen-tail match is needed instead. **The matcher rule is not written before
   the capture exists.**
2. **`GRACE` / `STALL` values.** No trustworthy measurement exists yet — every
   run this session was contaminated or blocked. Calibrate against real healthy
   launches; ship a too-slow `STALL` rather than a nagging one.
3. **Focus-terminal navigation.** Unverified. `Sidebar.tsx` exists and
   `terminalAlive` is tracked, so a terminal view exists to focus, but the
   navigation API has not been traced. If no clean route exists, the button
   degrades to copy only rather than blocking the change.

## Implementation order

0. Capture the real trust prompt: spawn `claude` via node-pty in a throwaway
   temp directory, capture the first few KB, kill without answering. Nothing is
   written to `~/.claude.json`. Yields the fixture for the matcher and resolves
   Open question 1.
1. `trustAttention.ts` + tests (pure; no wiring).
2. Trust precheck in `launchConfig.ts`, reusing the existing `jsonFile` helper
   and home-path resolution.
3. PTY matcher, modelled on `planUsageScraper.ts`.
4. IPC: type, projector, guard test.
5. Wiring in `main.ts`: feed inputs, schedule the deadline timer.
6. UI: card and indicator copy, focus-terminal action.

## Provenance

The interaction prescription (detect when reliable, copy as fallback; never
"press Enter"; clear on resolve; show an exit state) came from a Codex
consultation. A second adversarial Codex pass against the first draft produced
eight findings, all of which hold: the permanent latch, the unjustified
confirmed exit attribution, `!== true` merging unknown with false, clearing
erasing the failure, missing launch identity, an unreachable stall tier, the
timer equality trap, and the insufficient IPC guard. The `clientAlive` input was
verified wrong in code (`-NoExit`) and replaced with `completion()`.
