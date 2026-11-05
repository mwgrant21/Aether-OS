# AFK / Overnight Mode, Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Matt can say "going to bed", get a text pre-flight in an ordinary Aether terminal, approve a night once, and leave behind three machine-readable things Phase 2's runner can trust: a terms snapshot, a confirmed night list, and an approval record. Nothing runs overnight yet.

**Architecture:** Dependency-free ESM modules in `scripts/afk/` (`.mjs`, Node builtins only, same shape as `scripts/aether-hook-emit.mjs`, shipped by the existing `extraResources` rule). One CLI, `scripts/afk/afk.mjs`, has read verbs anyone can run and write verbs that refuse to run without a real TTY. A shipped skill, `skills/afk-preflight/SKILL.md`, drives the conversation (terms, compile, questions, feasibility, read-back) and tells Matt which TTY-gated command to type. State lives in `~/.aether-os/afk/`. No Electron, renderer, pty, or `.claude` config change.

**Tech Stack:** Node ESM (`.mjs`, builtins only), vitest (`// @vitest-environment node`), tests beside the modules as `scripts/afk/*.test.ts`.

**Spec:** `docs/superpowers/specs/2026-11-04-afk-mode-design.md` (approved by Matt 2026-11-04; sections 4-7, 10-12 govern this phase). Brainstorm record of what Matt said vs Claude's calls: `~/.claude/handoffs/aether-os/2026-11-04-afk-mode-brainstorm-notes.md`.

## Pinned ground

- Written against worktree `C:\Users\Matt\projects\aether-os\.worktrees\afk-design`, branch `docs/afk-mode-design`, HEAD `8ea6b53323326a7357fa6a3e6d182242158233b4` (the design doc commit, 1 ahead of origin/master, clean tree when this plan was written).
- `origin/master` = `dca17c627f4a819cda20a9e1976672f4ab45b131`. HEAD descends from it; the design commit touches docs only, so code here is identical to master.
- Builders: create `feat/afk-phase1` from the commit that contains this plan file. First command of every builder: `git merge-base --is-ancestor 8ea6b53 HEAD` must exit 0, else stop.
- Baseline: NOT RUN when this plan was written (the worktree has no `node_modules`). Builder runs `npm ci --ignore-scripts` (plain `npm ci` if node-pty fails to load), then `npx vitest run` once and quotes the counts before T1. Last count recorded elsewhere (stale, at 24611e3): 4214 pass / 17 skip / 0 fail.
- Scripts tests are collected twice: by the root vitest run and by `collector/vitest.config.ts` (`include: ['../scripts/**/*.test.ts']`). Every test here must pass under both (Node environment, builtins only).

## Global Constraints

- **No model calls, no `claude` launch, no `child_process`** anywhere in `scripts/afk/` (CLAUDE.md "Model calls"; `src/shared/noApiCalls.test.ts` scans `scripts/*.mjs`). No literal matching `/claude-[a-z]+-\d/` in non-test source. Pinned mechanically in T18.
- **`bypassPermissions` appears nowhere** in `scripts/afk/` or `skills/afk-preflight/` (design 12). Pinned in T18.
- **Node builtins only, ESM `.mjs`.** No npm dependency, no import from `src/`, `electron/` or `collector/` (the script runs as plain `node` spawned by Claude Code or PowerShell, outside the asar).
- **Injected clock.** Logic modules take `nowMs`; only `cli.mjs`/`afk.mjs` call `Date.now()`. Times are the machine's local time (design 12 "Clock").
- **Store the signal, not the payload** (docs/privacy-and-data.md). Persist item titles of at most 140 characters, `source.file` as a basename, `project` as the handoff folder name. Never an absolute path, never handoff body text.
- **Never read or print a secret value.** The feasibility probe reads key NAMES and reports booleans. Tests use a sentinel value and assert it never appears in output.
- **Writes only under `~/.aether-os/afk/`**, plus `install-skill` writing `~/.claude/skills/afk-preflight/SKILL.md` when Matt runs it. Tests ALWAYS use a temp home (`mkdtempSync`); a spawned CLI gets both `HOME` and `USERPROFILE` set. A test that touches the real home is a defect.
- **`delete` and `forcePush` can never be true** by any code path: not in the validator, not via amendment, not via `terms set` (T1, T3, T17).
- **Fail closed.** Unreadable or invalid terms read as defaults with a warning. Unknown keys are rejected, not ignored.
- Every test file starts with `// @vitest-environment node` (root default is jsdom).
- `scripts/` is scanned by `electron/remote/noWildcardListener.test.ts` (no `.listen(`, no symlinks inside the repo tree). Do not add either.
- Commit with explicit paths: `git add -- <paths>` then `git commit -m "…" -- <paths>`. Never `git add -A`. End each message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Do not edit `~/.claude/settings.json` or any file under `~/.claude` except through the `install-skill` code path in a test with a temp home. Pasting deny rules into settings is Matt's step (T21).

## Review Focus

1. **An approved night must never read the night-list file.** `resolveNightPlan` takes run items from `approval.json` only; a tampered `night-list.json` cannot add work. Pinned in T15.
2. **An unfinished pre-flight must run on the LAST-APPROVED snapshot, not the live terms file and not the unconfirmed amendments**, and only for items Matt confirmed. Pinned in T15.
3. **TTY gate.** `confirm`, `amend`, `approve`, `terms set` exit 3 and write nothing without a TTY on stdin and stdout. Pinned in T14 and T17 (spawned process, piped stdio).
4. **Classifier conservatism and the "decided" test.** Any `?` or marker word makes an item a question; barred wins over question; unchecked plan checkboxes are NOT evidence of undone work (every shipped plan in this repo has 0 checked boxes). Pinned in T9 and T10.
5. **No secret values leave the feasibility probe**, including via error strings. Pinned in T12.
6. **Snapshot and approval are write-once and hash-checked.** A snapshot whose terms no longer match its recorded hash is refused. Pinned in T5 and T6.

## Decisions (each answers one of the six planning questions; evidence is file:line at the pinned commit)

**D1. Standing terms: where, who writes.**
- Live file: `~/.aether-os/afk/terms.json`, a strict `v:1` object (T1). It follows the single-owner settings pattern: one module owns the file, fail-closed read, atomic tmp-then-rename write, readback returned instead of the requested value (`electron/controlSettings.ts:10-17` file and shape, `:25-31` fail-closed read, `:65-97` atomic write plus readback; `electron/collectorSettings.ts:36-51`). The dir is `aetherOsDir = ~/.aether-os` (`electron/main.ts:421`), made user-only by `ensurePrivateDir` (`electron/main.ts:956`).
- Deviation from that pattern, on purpose: the owner is `scripts/afk/termsStore.mjs`, not `electron/afkSettings.ts`, because the writer is a CLI Matt runs in a terminal, not the Electron main process, and `scripts/*.mjs` already write `~/.aether-os` (`scripts/aether-hook-emit.mjs`, spool). Phase 2's supervisor will read it; it will not write it.
- Who may write: only `afk terms set`, which needs a TTY (D2). Agents are blocked by two layers: the TTY gate, and a deny list (`buildDenyRules`, T16) that Matt pastes into settings (T21 step) covering `Edit/Write(~/.aether-os/afk/**)` and `Edit/Write(~/.claude/away*)`. Until Matt installs it, only the TTY gate protects an interactive session; this is stated in RISKS, not hidden.
- The file is NOT under `.claude`. Evidence: headless Claude Code hard-denies Write/Edit on any path with a `.claude` segment (`agent-improvement/scripts/away-cmd.ps1:9-15`), so the prototype's `~/.claude/away.json` could not hold a grant that workers must read but never write.
- Snapshot: at `approve`, a copy goes to `~/.aether-os/afk/nights/<nightId>/terms.snapshot.json` with its SHA-256, written once (`wx`), re-verified on every read (T5). The night runs on the snapshot (Phase 2).

**D2. How the text-first pre-flight runs in today's terminals.**
- Smallest mechanism: a CLI (`scripts/afk/afk.mjs`) plus a skill (`skills/afk-preflight/SKILL.md`). Aether terminals are plain PowerShell PTYs with `claude` typed into them (`electron/ptyManager.ts:10-12` `buildClaudeLaunchCommand`, `:57` `launchLine`, `:67-82` `spawnPty`); the agent already has Bash, so a skill that calls a CLI needs no Aether code change at all. The repo already ships a skill the same way (`skills/aether-cross-check/SKILL.md`, copied by hand into `~/.claude/skills/`); `install-skill` (T19) automates the copy and bakes in the CLI path.
- Matt's confirmations go through the TTY-gated verbs so the agent cannot approve on his behalf. `process.stdin.isTTY && process.stdout.isTTY` is false for an agent's Bash tool call. That is a guard against accident and drift, not a sandbox. UNVERIFIED: whether the claude TUI's `!` shell escape has a TTY; T21/M1 measures it. If it does not, Matt runs the gated verbs in a plain PowerShell window (the Aether-hosted slots all run `claude`, so a second shell is not available inside Aether without `/exit`).
- Trigger in Phase 1: Matt types `/afk-preflight`, or the skill's description matches his phrases (model-judged; best effort). The rules-first phrase detector with the tense guard is Phase 4 (design-kit part 7, line 232, `electron/control/inputRouter.ts`). This is a stated gap, not an equivalent.
- Rejected: (a) a `UserPromptSubmit` hook injecting context: hooks cannot hold a question-and-answer round and the detector is Phase 4; (b) Aether main writing the pre-flight into the pty through `terminalHub.writePort()` the way AetherChoice writes `/effort`: needs idle detection and screen watching, touches `main.ts`, and sits in the aether-gui lane; (c) an MCP tool server like `aether-data` (`electron.vite.config.ts:11`, `electron/dashboards/dataServerEntry.ts`): needs a new build entry and `claude mcp add`, adds nothing over CLI plus skill in Phase 1; (d) a slash-command file under `~/.claude/commands`: equivalent to the skill, but the repo has a `skills/` precedent and no commands one.

**D3. Night-list compiler: parse rules and the "decided" test (design 12).**
- Sources per project folder name (the handoff skill names it as the repo folder name): (1) the newest eligible handoff in `~/.claude/handoffs/<project>/`: file mtime within `maxAgeDays` (default 3), name not starting `ledger-|verdict-|scratch-|debug-`, containing a `## Next steps` heading; Matt may name more with `--handoff`. Items are the numbered lines under that heading until the next heading of level 1-2. (2) The newest `ledger-*.md`: lines `- [todo] …` and `- [pending …] …`. (3) Plans: only when a handoff/ledger item names the plan file, or Matt passes `--plan`. A plan's checkboxes are NOT read as progress: `docs/superpowers/plans/2026-10-12-dashboards.md` has 74 unchecked and 0 checked boxes and shipped as PR #119 (`PROGRESS.md:72`); `2026-09-30-real-severity.md` has 77/0, `2026-09-29-readiness-pass.md` 57/0.
- **Decided** means all of: it comes from one of those sources; its text carries no question or needs-Matt marker; it is not barred (delete, force-push, cleanup); if it references a plan, that plan's linked spec (`**Spec:**` line) has a Status line that says approved (not draft/awaiting/superseded) in its first 15 lines; and, for an APK/installer item, the feasibility check passes. Matt's per-item `confirm` at pre-flight is the final gate; nothing runs unconfirmed.
- Verdicts: `ready`, `question` (becomes a clarifying question), `barred` (never goes on the night; reported as cleanup/needs-Matt). Scope is explicit `--project` names; deriving them from the running terminals (design 12) is deferred to Phase 2, where Aether knows its terminals (UNVERIFIED mapping; the prototype's `session-pids/<id>.json` carries `cwd`).
- Stale-handoff risk: several handoffs in a lane can all carry Next steps, and nothing marks an old one DONE. Taking only the newest per project plus explicit `--handoff` is the conservative rule; Matt's confirmation catches the rest.

**D4. Feasibility check (design 7 step 4) and recipe table.** Phase 1 recipes exist only for the artifacts Matt named (APK, EXE/installer). Preconditions are probed by presence only. The commands are data for Phase 2; Phase 1 never runs them.

| Project | Artifact | cwd | Command | Preconditions probed (presence only) | Evidence |
|---|---|---|---|---|---|
| aether-os | installer | `.` | `npm run dist -- -c.directories.output={SCRATCH}` | `{SCRATCH}` supplied by the runner and outside any checkout the running dev instance watches | `CLAUDE.md` Run/test/build (`npm run dist`); `docs/packaging.md:15`; memory `aether-os-package-build-outside-dev-tree`. Arg forwarding through `npm run dist --` is UNVERIFIED on this install |
| aether-os | apk (aethermobile) | `android` | `gradlew.bat assembleDebug -PAETHER_TITAN_TAILNET_IP=100.84.175.105` | `local.properties` or env has `AETHER_KEYSTORE_PATH` (file exists), `AETHER_KEYSTORE_PASSWORD`, `AETHER_KEY_ALIAS`, `AETHER_KEY_PASSWORD`; `sdk.dir` | `android/app/build.gradle:12-19` (signing keys), `:25` (IP property), `:120-130` (release-only IP guard: a build without it silently yields an APK that says "TITAN ADDRESS NOT CONFIGURED"), `:143-151` (every package/sign/bundle task, any variant, needs the signing keys); memory `aether-android-titan-ip-build-prop`. Debug vs release as "the expected APK" is UNVERIFIED (Matt's call) |
| TarotApp | apk | `.` | `gradlew.bat assembleDebug` | none documented | `TarotApp/README.md:102-109`; phone is debug-signed (memory `tarotapp-phone-debug-signed`). Installing to the phone is never part of a night: "ready to install" is the goal |
| TokenMonitor | installer | `.` | `npm run dist` | file `codesign/pfx-password.txt` exists (presence only, never read) | `TokenMonitor/CLAUDE.md:25-36`. The PDQ deploy that `dist` mentions is outside the grant and not part of the recipe |

Projects with NO documented build recipe, so an APK/EXE item for them is held (`no build recipe`): MobileCrawler (Godot 4.7.2 export; CLAUDE.md:7,41 say paths live in Editor Settings and no export command is written down; Claude works in `MobileCrawler-t5`), nmmtools (`build.ps1` makes a script artifact, not an APK/EXE; tests must not run on the workstation, `nmmtools/CLAUDE.md:14-16`), tarot, Miriels-publish, TokenMonitorV2, uigen, cve-desk, and the rest of `~/projects`. Adding a row is a one-line change in `recipes.mjs`.

**D5. Aether-OS app vs the aether-gui lane.** Phase 1 touches NO file the lane owns. New files only: `scripts/afk/`, `skills/afk-preflight/`; plus three shared doc files (`CLAUDE.md`, `PROGRESS.md`, `docs/privacy-and-data.md`) that the lane also edits, so T20 should rebase on master immediately before it commits. The lane owns (design-kit-v1 part 7, lines 231-245; aetherchoice host spec): phrase detection in `electron/control/inputRouter.ts` (design-kit line 232), the thread host and AetherChoice (`electron/aetherChoice/`, with `awayMode(): boolean` at `applyEngine.ts:50` stubbed `() => false` at `pickHost.ts:229`), and the away banner, possible-away timer and return-summary UI (Phase 3-4). The Aether-OS side owns the supervisor, runner, delete queue and morning-report data (Phase 2-3, future `electron/afk/`). Phase 1 can therefore run in parallel with the lane's open PRs (they touch `main.ts`, `ptyManager.ts`, `terminalHub.ts`; this plan touches none). Phase 2 must wire `awayMode` through `runtime.ts`: coordinate with the lane then.

**D6. Prototype status and reuse** (`agent-improvement`, read at its `master` 69c8f59).
- `away-t1-lib` through `away-t5-prekill` are ancestors of master. `away-t6-handoff-write` is not an ancestor, but its single unique commit `22bd64f` has an identical added/removed-line set to master's `58553ce` (same subject; compared by hashing the sorted diff lines), so its content landed. The runner is DRY-RUN ONLY: live cycles print "not implemented" (`scripts/away-runner.ps1:66`).
- **Phase 1 reuses (as knowledge or vocabulary, not code):** the delete-verb entries and the `Edit/Write(~/.claude/away*)` entries of the deny list (`away-cmd.ps1:27-39`) feed `buildDenyRules` (T16); the finding that `.claude` paths are never writable headless (`away-cmd.ps1:9-15`) decides where the terms live (D1) and tells Phase 2 that workers write handoffs to `~/away-handoffs/<leaf>/` (`away-cmd.ps1:20-22`); the measured cost of about $0.30 per cold `claude -p` turn (`away-runner.ps1:7-9`) informs Phase 2 budgets.
- **Phase 1 must NOT reuse:** `~/.claude/away.json` as a grant store (wrong location, holds run state not authority); the prototype's blanket denial of `git push`, `git merge`, `gh`, `git checkout`, `git switch`, `git stash`, `git worktree` (`away-cmd.ps1:27-37`): design 5 and 11 supersede it (push and merge are allowed), so `buildDenyRules` denies pushes only when `terms.push` is false; `Get-AwayPaths`/`Write-AwayState` (they write under `.claude`); any `claude -p` exit-code branching (the prototype measured exit 0 on failure, `away-runner.ps1:11-13`). `pre-kill-check.ps1`, `away-relaunch.ps1` and `session-pid-onstart.mjs` are Phase 2 supervisor references with no Phase 1 use.
- No PowerShell is written in Phase 1, so `~/.claude/rules/powershell.md` and `ps51-verifier` are not triggered. If Phase 2 reuses the `.ps1` scripts, they must follow it.

## Interfaces Phase 1 exposes to Phase 2

| Interface | Module | Contract |
|---|---|---|
| **Terms snapshot** | `snapshot.mjs` `readSnapshot(aetherDir, nightId)` | `{ok:true, snapshot:{v,nightId,takenAtMs,liveSha256,amendments,terms,termsSha256}}` or `{ok:false, reason}`; hash re-verified on read; written once at approval |
| **Night list** | `nightList.mjs` `readNightList(aetherDir, nightId)` | Compiled and annotated items with per-item `confirmed`, `feasibility`. A pre-flight workspace. **Phase 2 must not use it to decide what to run** |
| **Approval record** | `approval.mjs` `readApproval(aetherDir, nightId)` | `{v,nightId,approvedAtMs,via:'tty',termsSha256,items:[{id,project,kind,artifact,title,source}],held:[{id,title,verdict,reason}]}`; write-once. `items` is the run list |
| **What to run tonight** | `resolvePlan.mjs` `resolveNightPlan({aetherDir, nowMs})` | `{kind:'approved'|'unfinished'|'none', nightId?, terms?, termsSha256?, items, held, reason}`. The one entry point the Phase 2 supervisor calls at window start |
| **Enforcement vocabulary** | `denyRules.mjs` `buildDenyRules(terms)` | Permission-rule strings for the headless argv and for Matt's settings |
| **Build recipes** | `recipes.mjs` `getRecipe(project, artifact)` | `{cwd, argv, requires, evidence, verified}` |
| **Night paths** | `nights.mjs` `nightPaths`, `listNightIds`, `windowFor`, `isNightCurrent` | Shared layout and window maths |

Phase 2 adds `.d.mts` declarations beside these files when `electron/` first imports them (precedent: `scripts/sync-severity-core.d.mts`); Phase 1 documents shapes with JSDoc `@typedef`.

## File map

| File | Responsibility |
|---|---|
| `scripts/afk/terms.mjs` (+test) | Terms schema, defaults, validation, amendments, canonical hash |
| `scripts/afk/fsJson.mjs` (+test) | Safe JSON read, atomic write, write-once |
| `scripts/afk/termsStore.mjs` (+test) | The live terms file: single owner |
| `scripts/afk/nights.mjs` (+test) | Night ids, paths, window maths |
| `scripts/afk/snapshot.mjs` (+test) | Terms snapshot at approval |
| `scripts/afk/approval.mjs` (+test) | Approval record and last-approved pointer |
| `scripts/afk/parseSources.mjs` (+test) | Handoff Next steps and ledger todo parsers |
| `scripts/afk/planRefs.mjs` (+test) | Plan references, spec-approved test |
| `scripts/afk/classify.mjs` (+test) | The "decided" classifier |
| `scripts/afk/compileNightList.mjs` (+test) | Compiler |
| `scripts/afk/recipes.mjs` (+test) | Build recipe table, artifact detection |
| `scripts/afk/feasibility.mjs` (+test) | Presence-only feasibility probes |
| `scripts/afk/nightList.mjs` (+test) | Night workspace: open, annotate, confirm, amend |
| `scripts/afk/approveFlow.mjs` (+test) | Approval flow, TTY and phrase gate |
| `scripts/afk/resolvePlan.mjs` (+test) | `resolveNightPlan` |
| `scripts/afk/denyRules.mjs` (+test) | Deny-rule builder |
| `scripts/afk/cli.mjs`, `afk.mjs` (+test) | Verb dispatch and the executable entry |
| `scripts/afk/afkBoundary.test.ts` | Guard test for the directory |
| `scripts/afk/installSkill.mjs` (+test), `skills/afk-preflight/SKILL.md` | Skill and installer |
| `docs/privacy-and-data.md`, `CLAUDE.md`, `PROGRESS.md` | Document the new persisted state |

## Order and parallelism

Sequential spine: T1 -> T2 -> T3 -> T4 -> T5 -> T6 -> (T13 needs T10, T12) -> T14 -> T15 -> T17 -> T18 -> T19 -> T20 -> T21. Independent of the spine and of each other (disjoint files, safe in separate worktrees, merge in numeric order): T7, T8, T9 (then T10 after all three); T11 (then T12); T16 (after T1). Subagent-driven execution is sequential by default: follow numeric order unless dispatching those groups in parallel.

---

### Task 1: Terms schema

**Files:**
- Create: `scripts/afk/terms.mjs`
- Test: `scripts/afk/terms.test.ts`

```owned T1
scripts/afk/terms.mjs
scripts/afk/terms.test.ts
```

**Interfaces:**
- Produces: `DEFAULT_TERMS` (deep-frozen), `AMENDABLE_KEYS = ['window','push','merge','codexReviewsPerPush','opusEscalation','fableElevation']`, `validateTerms(input: unknown): {ok:true; terms} | {ok:false; errors: string[]}`, `applyAmendments(base, patch): same result shape`, `canonicalJson(value): string` (keys sorted recursively), `termsSha256(terms): string` (hex).
- Shape: `{v:1, window:{start:'HH:MM', end:'HH:MM'}, push:boolean, merge:'gated'|'off', delete:false, forcePush:false, codexReviewsPerPush:0..3 integer, opusEscalation:boolean, fableElevation:boolean, notifications:'silent'}`. Exactly these keys; unknown keys rejected.
- Rules: `start !== end`; `fableElevation` requires `opusEscalation` (design 5: Fable follows three failed Opus reviews; this is Claude's call, flagged in OPEN); `codexReviewsPerPush` capped at 3 (Matt approved up to 3); `delete`/`forcePush` must be exactly `false` (force-push counts as delete; design 13 open item, kept barred). `merge:'gated'` means only with a refuter ACCEPT for the exact head via merge-gate (design 5); the flag is a promise Phase 2 enforces.
- `applyAmendments` only accepts `AMENDABLE_KEYS` (a whole `window` object, not a half), returns a new object, and re-runs `validateTerms` on the result.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMS, applyAmendments, termsSha256, validateTerms } from './terms.mjs';

const w = (over: Record<string, unknown>) => ({ ...DEFAULT_TERMS, ...over });

describe('DEFAULT_TERMS', () => {
  it('matches design section 5 and is frozen', () => {
    expect(DEFAULT_TERMS).toMatchObject({
      window: { start: '01:00', end: '07:00' }, push: true, merge: 'gated', delete: false, forcePush: false,
      codexReviewsPerPush: 3, opusEscalation: false, fableElevation: false, notifications: 'silent',
    });
    expect(Object.isFrozen(DEFAULT_TERMS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TERMS.window)).toBe(true);
  });
});

describe('validateTerms', () => {
  it('accepts the defaults', () => {
    const r = validateTerms(structuredClone(DEFAULT_TERMS));
    expect(r.ok && r.terms).toEqual(DEFAULT_TERMS);
  });

  it.each([
    ['delete true', w({ delete: true }), 'delete'],
    ['forcePush true', w({ forcePush: true }), 'forcePush'],
    ['4 reviews', w({ codexReviewsPerPush: 4 }), 'codexReviewsPerPush'],
    ['fractional reviews', w({ codexReviewsPerPush: 1.5 }), 'codexReviewsPerPush'],
    ['bad clock', w({ window: { start: '25:00', end: '07:00' } }), 'window'],
    ['zero-length window', w({ window: { start: '01:00', end: '01:00' } }), 'window'],
    ['fable without opus', w({ fableElevation: true, opusEscalation: false }), 'fableElevation'],
    ['unknown key', w({ bypassPermissions: true }), 'bypassPermissions'],
    ['loud notifications', w({ notifications: 'toast' }), 'notifications'],
    ['bad merge mode', w({ merge: 'always' }), 'merge'],
    ['missing key', (() => { const { push: _p, ...rest } = DEFAULT_TERMS; return rest; })(), 'push'],
    ['not an object', 'x', 'object'],
    ['array', [], 'object'],
  ])('rejects %s', (_n, input, key) => {
    const r = validateTerms(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain(key);
  });
});

describe('applyAmendments', () => {
  it('applies an amendable key without mutating the base', () => {
    const r = applyAmendments(DEFAULT_TERMS, { opusEscalation: true, window: { start: '00:30', end: '06:00' } });
    expect(r.ok && r.terms.opusEscalation).toBe(true);
    expect(r.ok && r.terms.window.start).toBe('00:30');
    expect(DEFAULT_TERMS.opusEscalation).toBe(false);
  });
  it.each(['delete', 'forcePush', 'notifications', 'v'])('refuses to amend %s', (k) => {
    const r = applyAmendments(DEFAULT_TERMS, { [k]: k === 'v' ? 2 : true });
    expect(r.ok).toBe(false);
  });
  it('re-validates the merged result (fable on with opus off)', () => {
    expect(applyAmendments(DEFAULT_TERMS, { fableElevation: true }).ok).toBe(false);
    expect(applyAmendments(DEFAULT_TERMS, { fableElevation: true, opusEscalation: true }).ok).toBe(true);
  });
});

describe('termsSha256', () => {
  it('ignores key order and changes with any value', () => {
    const a = termsSha256(DEFAULT_TERMS);
    const reordered = Object.fromEntries(Object.entries(DEFAULT_TERMS).reverse());
    expect(termsSha256(reordered as typeof DEFAULT_TERMS)).toBe(a);
    expect(termsSha256({ ...DEFAULT_TERMS, push: false })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run scripts/afk/terms.test.ts`
Expected: FAIL, cannot resolve `./terms.mjs`.

- [ ] **Step 3: Implement `terms.mjs`** to the interface above. Deep-freeze the defaults. No logic beyond the stated rules.

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run scripts/afk/terms.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
P="scripts/afk/terms.mjs scripts/afk/terms.test.ts"
git add -- $P && git commit -m "feat(afk): standing terms schema, validation and amendments" -- $P
```

---

### Task 2: Safe JSON file helpers

**Files:**
- Create: `scripts/afk/fsJson.mjs`
- Test: `scripts/afk/fsJson.test.ts`

```owned T2
scripts/afk/fsJson.mjs
scripts/afk/fsJson.test.ts
```

**Interfaces:**
- Produces: `readJsonSafe(path): {ok:true; value} | {ok:false; reason:'missing'|'unreadable'|'invalid-json'}` (never throws); `writeJsonAtomic(path, value): void` (creates parents, writes a sibling `*.afktmp-<pid>-<hex>` then renames over the target, removes the tmp on failure, **throws** if the target is a symlink); `writeJsonOnce(path, value): void` (flag `wx`, throws with `code === 'EEXIST'` when the file exists).
- Notes: JSON is written as `JSON.stringify(value, null, 2) + '\n'`, UTF-8, no BOM. Symlink refusal exists because the atomic replace would otherwise swap a link for a regular file (memory `atomic-file-replace-edge-cases`); the afk dir is Aether's own, so refusing is simpler than following.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonSafe, writeJsonAtomic, writeJsonOnce } from './fsJson.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'afk-fsjson-'));

describe('readJsonSafe', () => {
  it('reports missing, invalid-json and ok without throwing', () => {
    const d = tmp();
    expect(readJsonSafe(join(d, 'nope.json'))).toEqual({ ok: false, reason: 'missing' });
    writeFileSync(join(d, 'bad.json'), '{oops');
    expect(readJsonSafe(join(d, 'bad.json'))).toEqual({ ok: false, reason: 'invalid-json' });
    writeFileSync(join(d, 'ok.json'), '{"a":1}');
    expect(readJsonSafe(join(d, 'ok.json'))).toEqual({ ok: true, value: { a: 1 } });
  });
});

describe('writeJsonAtomic', () => {
  it('creates parents, replaces the file and leaves no temp file', () => {
    const d = tmp();
    const p = join(d, 'a', 'b', 'x.json');
    writeJsonAtomic(p, { n: 1 });
    writeJsonAtomic(p, { n: 2 });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ n: 2 });
    expect(readdirSync(join(d, 'a', 'b'))).toEqual(['x.json']);
  });
  it('refuses a symlink target', (ctx) => {
    const d = tmp();
    writeFileSync(join(d, 'real.json'), '{}');
    try { symlinkSync(join(d, 'real.json'), join(d, 'link.json')); } catch { ctx.skip(); return; }
    expect(() => writeJsonAtomic(join(d, 'link.json'), { n: 1 })).toThrow(/symlink/i);
  });
});

describe('writeJsonOnce', () => {
  it('refuses to overwrite', () => {
    const d = tmp();
    writeJsonOnce(join(d, 'once.json'), { n: 1 });
    expect(() => writeJsonOnce(join(d, 'once.json'), { n: 2 })).toThrow(/EEXIST|exists/i);
    expect(JSON.parse(readFileSync(join(d, 'once.json'), 'utf8'))).toEqual({ n: 1 });
  });
});
```

- [ ] **Step 2:** `npx vitest run scripts/afk/fsJson.test.ts` -> FAIL, cannot resolve `./fsJson.mjs`.
- [ ] **Step 3: Implement `fsJson.mjs`** to the interface.
- [ ] **Step 4:** `npx vitest run scripts/afk/fsJson.test.ts` -> PASS (the symlink case may report skipped on a machine without symlink rights; say so in the report).
- [ ] **Step 5: Commit**

```bash
P="scripts/afk/fsJson.mjs scripts/afk/fsJson.test.ts"
git add -- $P && git commit -m "feat(afk): safe JSON read, atomic write and write-once helpers" -- $P
```

---

### Task 3: Live terms store (the single owner)

**Files:**
- Create: `scripts/afk/termsStore.mjs`
- Test: `scripts/afk/termsStore.test.ts`

```owned T3
scripts/afk/termsStore.mjs
scripts/afk/termsStore.test.ts
```

**Interfaces:**
- Consumes: `validateTerms`, `DEFAULT_TERMS` (T1); `readJsonSafe`, `writeJsonAtomic` (T2).
- Produces: `afkDir(aetherDir) = join(aetherDir,'afk')`, `termsPath(aetherDir) = join(afkDir,'terms.json')`, `readLiveTerms(aetherDir): {terms, source:'file'|'defaults', warnings: string[]}` (never throws; missing file = defaults with no warning; unreadable, invalid JSON or invalid terms = defaults plus one warning naming the reason, never the file content), `writeLiveTerms(aetherDir, terms): {ok:boolean; terms; errors: string[]}` (validates first; invalid input writes nothing; returns the READBACK from disk, following the `controlSettings.ts:65-97` rule).

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_TERMS } from './terms.mjs';
import { readLiveTerms, termsPath, writeLiveTerms } from './termsStore.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'afk-terms-'));
const put = (dir: string, text: string) => { mkdirSync(dirname(termsPath(dir)), { recursive: true }); writeFileSync(termsPath(dir), text); };

describe('readLiveTerms', () => {
  it('missing file reads as defaults with no warning', () => {
    expect(readLiveTerms(tmp())).toEqual({ terms: DEFAULT_TERMS, source: 'defaults', warnings: [] });
  });
  it('corrupt JSON fails closed to defaults with a warning', () => {
    const d = tmp(); put(d, '{nope');
    const r = readLiveTerms(d);
    expect(r.source).toBe('defaults'); expect(r.terms).toEqual(DEFAULT_TERMS); expect(r.warnings.length).toBe(1);
  });
  it('a file that tries delete:true fails closed to defaults', () => {
    const d = tmp(); put(d, JSON.stringify({ ...DEFAULT_TERMS, delete: true }));
    const r = readLiveTerms(d);
    expect(r.terms.delete).toBe(false); expect(r.source).toBe('defaults'); expect(r.warnings.join(' ')).toContain('delete');
  });
});

describe('writeLiveTerms', () => {
  it('round-trips and returns the readback', () => {
    const d = tmp();
    const r = writeLiveTerms(d, { ...DEFAULT_TERMS, codexReviewsPerPush: 2 });
    expect(r.ok).toBe(true); expect(r.terms.codexReviewsPerPush).toBe(2);
    expect(readLiveTerms(d)).toMatchObject({ source: 'file', terms: { codexReviewsPerPush: 2 } });
  });
  it('writes nothing for invalid terms', () => {
    const d = tmp();
    const r = writeLiveTerms(d, { ...DEFAULT_TERMS, forcePush: true });
    expect(r.ok).toBe(false); expect(r.errors.join(' ')).toContain('forcePush');
    expect(existsSync(termsPath(d))).toBe(false);
  });
  it('leaves only terms.json in the dir', () => {
    const d = tmp(); writeLiveTerms(d, DEFAULT_TERMS);
    expect(readdirSync(dirname(termsPath(d)))).toEqual(['terms.json']);
  });
});
```

- [ ] **Step 2:** `npx vitest run scripts/afk/termsStore.test.ts` -> FAIL, cannot resolve.
- [ ] **Step 3: Implement `termsStore.mjs`.**
- [ ] **Step 4:** same command -> PASS.
- [ ] **Step 5: Commit**

```bash
P="scripts/afk/termsStore.mjs scripts/afk/termsStore.test.ts"
git add -- $P && git commit -m "feat(afk): live standing-terms store with fail-closed read" -- $P
```

---

### Task 4: Night ids, paths and window maths

**Files:**
- Create: `scripts/afk/nights.mjs`
- Test: `scripts/afk/nights.test.ts`

```owned T4
scripts/afk/nights.mjs
scripts/afk/nights.test.ts
```

**Interfaces:**
- Produces: `NIGHT_ID_PATTERN = /^n\d{8}T\d{6}$/`; `newNightId(nowMs): string` (local time, `n20261104T231509`); `nightPaths(aetherDir, nightId): {dir, list, snapshot, approval}` under `<afk>/nights/<nightId>/` with files `night-list.json`, `terms.snapshot.json`, `approval.json` (throws on an id that fails the pattern: path traversal guard, since ids arrive on the command line); `listNightIds(aetherDir): string[]` newest first (ignores entries that fail the pattern); `windowFor(nowMs, {start,end}): {startMs, endMs}` = the window containing `nowMs`, else the next one (an `end <= start` window crosses midnight; `nowMs === endMs` counts as over); `GRACE_MS = 12*3600*1000`; `isNightCurrent(nowMs, targetWindowStartMs, graceMs = GRACE_MS): boolean` = `nowMs <= target + graceMs`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNightCurrent, listNightIds, newNightId, nightPaths, windowFor } from './nights.mjs';

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const W = { start: '01:00', end: '07:00' };

describe('newNightId / nightPaths', () => {
  it('formats local time', () => {
    expect(newNightId(new Date(2026, 10, 4, 23, 15, 9).getTime())).toBe('n20261104T231509');
  });
  it.each(['../x', 'n2026', 'n20261104T231509/..', ''])('rejects id %j', (id) => {
    expect(() => nightPaths('/a', id)).toThrow();
  });
  it('lays out the three files', () => {
    const p = nightPaths('/a', 'n20261104T231509');
    expect(p.list.endsWith('night-list.json')).toBe(true);
    expect(p.snapshot.endsWith('terms.snapshot.json')).toBe(true);
    expect(p.approval.endsWith('approval.json')).toBe(true);
  });
});

describe('listNightIds', () => {
  it('newest first, junk ignored', () => {
    const d = mkdtempSync(join(tmpdir(), 'afk-nights-'));
    for (const n of ['n20261103T220000', 'n20261104T231509', 'junk']) mkdirSync(join(d, 'afk', 'nights', n), { recursive: true });
    expect(listNightIds(d)).toEqual(['n20261104T231509', 'n20261103T220000']);
  });
});

describe('windowFor', () => {
  it('before bed: the next 01:00', () => {
    expect(windowFor(at(4, 23), W)).toEqual({ startMs: at(5, 1), endMs: at(5, 7) });
  });
  it('inside the window: the current one', () => {
    expect(windowFor(at(5, 2), W)).toEqual({ startMs: at(5, 1), endMs: at(5, 7) });
  });
  it('exactly at the end counts as over', () => {
    expect(windowFor(at(5, 7), W).startMs).toBe(at(6, 1));
  });
  it('a window that crosses midnight', () => {
    expect(windowFor(at(4, 23), { start: '22:00', end: '06:00' })).toEqual({ startMs: at(4, 22), endMs: at(5, 6) });
    expect(windowFor(at(4, 12), { start: '22:00', end: '06:00' }).startMs).toBe(at(4, 22));
  });
});

describe('isNightCurrent', () => {
  it('valid until 12h after the targeted window start', () => {
    expect(isNightCurrent(at(5, 13), at(5, 1))).toBe(true);
    expect(isNightCurrent(at(5, 13, 1), at(5, 1))).toBe(false);
  });
});
```

- [ ] **Step 2:** `npx vitest run scripts/afk/nights.test.ts` -> FAIL.
- [ ] **Step 3: Implement `nights.mjs`.** Local-time maths via `new Date(y,m,d,h,mi)`; no timezone library.
- [ ] **Step 4:** -> PASS.
- [ ] **Step 5: Commit**

```bash
P="scripts/afk/nights.mjs scripts/afk/nights.test.ts"
git add -- $P && git commit -m "feat(afk): night ids, directory layout and window maths" -- $P
```

---

### Task 5: Terms snapshot

**Files:**
- Create: `scripts/afk/snapshot.mjs`
- Test: `scripts/afk/snapshot.test.ts`

```owned T5
scripts/afk/snapshot.mjs
scripts/afk/snapshot.test.ts
```

**Interfaces:**
- Consumes: `termsSha256`, `validateTerms` (T1); `writeJsonOnce`, `readJsonSafe` (T2); `nightPaths` (T4).
- Produces: `writeSnapshot(aetherDir, nightId, {terms, amendments, liveSha256, nowMs}): Snapshot` (validates terms, computes `termsSha256`, write-once, throws on `EEXIST`); `readSnapshot(aetherDir, nightId): {ok:true; snapshot} | {ok:false; reason:'missing'|'invalid'|'hash-mismatch'}`. `Snapshot = {v:1, nightId, takenAtMs, liveSha256, amendments, terms, termsSha256}`. `liveSha256` is the hash of the LIVE terms at approval (so a later diff shows what was amended); `termsSha256` hashes the EFFECTIVE terms.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TERMS, termsSha256 } from './terms.mjs';
import { nightPaths } from './nights.mjs';
import { readSnapshot, writeSnapshot } from './snapshot.mjs';

const ID = 'n20261104T231509';
const tmp = () => mkdtempSync(join(tmpdir(), 'afk-snap-'));
const args = { terms: DEFAULT_TERMS, amendments: {}, liveSha256: termsSha256(DEFAULT_TERMS), nowMs: 1 };

describe('snapshot', () => {
  it('round-trips with a verified hash', () => {
    const d = tmp(); writeSnapshot(d, ID, args);
    const r = readSnapshot(d, ID);
    expect(r.ok && r.snapshot.terms).toEqual(DEFAULT_TERMS);
    expect(r.ok && r.snapshot.termsSha256).toBe(termsSha256(DEFAULT_TERMS));
  });
  it('is write-once', () => {
    const d = tmp(); writeSnapshot(d, ID, args);
    expect(() => writeSnapshot(d, ID, { ...args, terms: { ...DEFAULT_TERMS, push: false } })).toThrow(/EEXIST|exists/i);
  });
  it('refuses a snapshot whose terms were edited after the hash was recorded', () => {
    const d = tmp(); writeSnapshot(d, ID, args);
    const p = nightPaths(d, ID).snapshot;
    const j = JSON.parse(readFileSync(p, 'utf8')); j.terms.opusEscalation = true;
    writeFileSync(p, JSON.stringify(j));
    expect(readSnapshot(d, ID)).toEqual({ ok: false, reason: 'hash-mismatch' });
  });
  it('refuses to snapshot invalid terms', () => {
    expect(() => writeSnapshot(tmp(), ID, { ...args, terms: { ...DEFAULT_TERMS, delete: true } })).toThrow();
  });
  it('missing reads as missing', () => {
    expect(readSnapshot(tmp(), ID)).toEqual({ ok: false, reason: 'missing' });
  });
});
```

- [ ] **Step 2:** `npx vitest run scripts/afk/snapshot.test.ts` -> FAIL.
- [ ] **Step 3: Implement `snapshot.mjs`.**
- [ ] **Step 4:** -> PASS.
- [ ] **Step 5: Commit**

```bash
P="scripts/afk/snapshot.mjs scripts/afk/snapshot.test.ts"
git add -- $P && git commit -m "feat(afk): write-once hash-verified terms snapshot" -- $P
```

---

### Task 6: Approval record and last-approved pointer

**Files:**
- Create: `scripts/afk/approval.mjs`
- Test: `scripts/afk/approval.test.ts`

```owned T6
scripts/afk/approval.mjs
scripts/afk/approval.test.ts
```

**Interfaces:**
- Consumes: T2, T4, T5.
- Produces: `writeApproval(aetherDir, nightId, record): Approval` (write-once; `record = {approvedAtMs, termsSha256, items, held}`; stamps `v:1, nightId, via:'tty'`); `readApproval(aetherDir, nightId): Approval | null` (null on missing or invalid shape); `writeLastApproved(aetherDir, {nightId, termsSha256, approvedAtMs}): void` (atomic, overwrites: it is a pointer); `readLastApproved(aetherDir): {nightId, approvedAtMs, snapshot} | null`. The pointer is honoured ONLY if the snapshot it names verifies (T5) AND its `termsSha256` equals the pointer's; otherwise `null`.
- `Approval.items[]` = `{id, project, kind, artifact, title, source}`; `held[]` = `{id, title, verdict, reason}`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TERMS, termsSha256 } from './terms.mjs';
import { nightPaths } from './nights.mjs';
import { writeSnapshot } from './snapshot.mjs';
import { readApproval, readLastApproved, writeApproval, writeLastApproved } from './approval.mjs';

const ID = 'n20261104T231509';
const H = termsSha256(DEFAULT_TERMS);
const tmp = () => mkdtempSync(join(tmpdir(), 'afk-appr-'));
const item = { id: 'a1b2c3d4e5f6', project: 'aether-os', kind: 'work', artifact: null, title: 't', source: { kind: 'handoff', file: 'h.md' } };

describe('approval record', () => {
  it('round-trips and stamps version, night and via', () => {
    const d = tmp();
    writeApproval(d, ID, { approvedAtMs: 5, termsSha256: H, items: [item], held: [] });
    expect(readApproval(d, ID)).toMatchObject({ v: 1, nightId: ID, via: 'tty', termsSha256: H, items: [item] });
  });
  it('is write-once', () => {
    const d = tmp(); const r = { approvedAtMs: 5, termsSha256: H, items: [], held: [] };
    writeApproval(d, ID, r);
    expect(() => writeApproval(d, ID, r)).toThrow(/EEXIST|exists/i);
  });
  it('missing reads as null', () => { expect(readApproval(tmp(), ID)).toBeNull(); });
});

describe('last-approved pointer', () => {
  it('resolves to the verified snapshot', () => {
    const d = tmp();
    writeSnapshot(d, ID, { terms: DEFAULT_TERMS, amendments: {}, liveSha256: H, nowMs: 1 });
    writeLastApproved(d, { nightId: ID, termsSha256: H, approvedAtMs: 5 });
    const r = readLastApproved(d);
    expect(r?.nightId).toBe(ID); expect(r?.snapshot.terms).toEqual(DEFAULT_TERMS);
  });
  it('is null when the snapshot is gone', () => {
    const d = tmp();
    writeSnapshot(d, ID, { terms: DEFAULT_TERMS, amendments: {}, liveSha256: H, nowMs: 1 });
    writeLastApproved(d, { nightId: ID, termsSha256: H, approvedAtMs: 5 });
    rmSync(nightPaths(d, ID).snapshot);
    expect(readLastApproved(d)).toBeNull();
  });
  it('is null when the pointer hash disagrees with the snapshot', () => {
    const d = tmp();
    writeSnapshot(d, ID, { terms: DEFAULT_TERMS, amendments: {}, liveSha256: H, nowMs: 1 });
    writeLastApproved(d, { nightId: ID, termsSha256: 'f'.repeat(64), approvedAtMs: 5 });
    expect(readLastApproved(d)).toBeNull();
  });
  it('is null when no pointer exists', () => { expect(readLastApproved(tmp())).toBeNull(); });
});
```

- [ ] **Step 2:** `npx vitest run scripts/afk/approval.test.ts` -> FAIL.
- [ ] **Step 3: Implement `approval.mjs`.** Pointer file: `<afk>/last-approved.json`.
- [ ] **Step 4:** -> PASS.
- [ ] **Step 5: Commit**

```bash
P="scripts/afk/approval.mjs scripts/afk/approval.test.ts"
git add -- $P && git commit -m "feat(afk): write-once approval record and last-approved pointer" -- $P
```

---

### Task 7: Handoff and ledger parsers

**Files:**
- Create: `scripts/afk/parseSources.mjs`
- Test: `scripts/afk/parseSources.test.ts`

```owned T7
scripts/afk/parseSources.mjs
scripts/afk/parseSources.test.ts
```

**Interfaces:**
- Produces: `parseNextSteps(markdown): {found:boolean; headingNote: string|null; items: {n:number; text:string}[]}`; `parseLedgerTodos(markdown): {state:'todo'|'pending'; note:string|null; text:string}[]`.
- Rules (D3): the section starts at a line matching `/^#{2,3}\s+Next steps\b(.*)$/i` (text after `Next steps`, e.g. `(all need Matt)`, becomes `headingNote` with the surrounding parentheses removed) and ends at the next heading of level 1 or 2 (a `##` such as `## Update 12:50 - …` ends it; `###` does not). Items start at a line `^\s{0,1}(\d+)\.\s+(.*)$`; following non-blank lines that are not a new item are joined with single spaces. Lines inside a fenced code block are ignored. Ledger: `^- \[(todo|pending[^\]]*)\]\s*(.*)$`, case-insensitive; `pending Matt` gives `state:'pending', note:'Matt'`; `[done]`, `[running]`, `[MERGED …]` are not returned.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseLedgerTodos, parseNextSteps } from './parseSources.mjs';

describe('parseNextSteps', () => {
  it('collects numbered items, joins continuation lines, stops at the next ## heading', () => {
    const md = '# H\n\n## Next steps\n1. First thing\n   continues here\n2. Second thing\n\n## Decisions\n- not me\n';
    expect(parseNextSteps(md)).toEqual({
      found: true, headingNote: null,
      items: [{ n: 1, text: 'First thing continues here' }, { n: 2, text: 'Second thing' }],
    });
  });
  it('a ## Update heading ends the section but ### does not', () => {
    const md = '## Next steps\n1. A\n### Sub\n2. B\n## Update 12:50 - x\n3. C\n';
    expect(parseNextSteps(md).items.map((i) => i.text)).toEqual(['A', 'B']);
  });
  it('keeps the heading note', () => {
    expect(parseNextSteps('## Next steps (all need Matt)\n1. Do it\n').headingNote).toBe('all need Matt');
  });
  it('ignores numbered lines in code fences', () => {
    const md = '## Next steps\n1. Real\n```\n2. fake\n```\n';
    expect(parseNextSteps(md).items.map((i) => i.text)).toEqual(['Real']);
  });
  it('reports not found', () => {
    expect(parseNextSteps('# nothing here\n')).toEqual({ found: false, headingNote: null, items: [] });
  });
});

describe('parseLedgerTodos', () => {
  it('returns todo and pending, nothing else', () => {
    const md = '- [todo] read-only tally\n- [done] x\n- [pending Matt] collector restart\n- [running] y\n- [MERGED 22c5f68] z\n';
    expect(parseLedgerTodos(md)).toEqual([
      { state: 'todo', note: null, text: 'read-only tally' },
      { state: 'pending', note: 'Matt', text: 'collector restart' },
    ]);
  });
});
```

- [ ] **Step 2:** `npx vitest run scripts/afk/parseSources.test.ts` -> FAIL.
- [ ] **Step 3: Implement `parseSources.mjs`.**
- [ ] **Step 4:** -> PASS.
- [ ] **Step 5: Commit**

```bash
P="scripts/afk/parseSources.mjs scripts/afk/parseSources.test.ts"
git add -- $P && git commit -m "feat(afk): parse handoff Next steps and ledger todos" -- $P
```

---

### Task 8: Plan references and the spec-approved test

**Files:**
- Create: `scripts/afk/planRefs.mjs`
- Test: `scripts/afk/planRefs.test.ts`

```owned T8
scripts/afk/planRefs.mjs
scripts/afk/planRefs.test.ts
```

**Interfaces:**
- Produces: `specIsApproved(markdown): boolean`; `specPathOfPlan(markdown): string|null`; `planRefsIn(text): string[]` (plan file basenames, in order, de-duplicated).
- `specIsApproved`: look only at the first 15 lines for a line containing `status` (case-insensitive, optional `**`/`-`/`:` decoration) whose text matches `/\bapproved\b/i` and does NOT match `/\b(awaiting|not approved|unapproved|draft|superseded|rejected)\b/i`.
- `specPathOfPlan`: the first backticked path on a line starting `**Spec:**`.
- `planRefsIn`: matches `docs/superpowers/plans/<name>.md` or `plans/<name>.md`, `<name>` limited to `[\w.-]+`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { planRefsIn, specIsApproved, specPathOfPlan } from './planRefs.mjs';

describe('specIsApproved', () => {
  it.each([
    ['plain', '# T\n\nStatus: APPROVED by Matt 2026-11-04 as written.\n', true],
    ['bold with comma', '# T\n**Status:** Approved, pending implementation plan\n', true],
    ['lowercase with date', 'Status: approved 2026-10-11. Amended\n', true],
    ['bullet', '- **Status:** design approved in conversation, awaiting written-spec review\n', false],
    ['draft', 'Status: DRAFT\n', false],
    ['superseded', 'Status: approved, superseded by x\n', false],
    ['no status line', '# T\nsome text\n', false],
    ['status after line 15', '\n'.repeat(16) + 'Status: approved\n', false],
  ])('%s', (_n, md, want) => { expect(specIsApproved(md)).toBe(want); });
});

describe('specPathOfPlan', () => {
  it('takes the first backticked path on the **Spec:** line', () => {
    expect(specPathOfPlan('x\n**Spec:** `docs/superpowers/specs/a-design.md` (note `b`)\n')).toBe('docs/superpowers/specs/a-design.md');
  });
  it('null when absent', () => { expect(specPathOfPlan('no spec line')).toBeNull(); });
});

describe('planRefsIn', () => {
  it('finds plan files by either prefix, de-duplicated', () => {
    expect(planRefsIn('see docs/superpowers/plans/2026-10-12-dashboards.md T3 and plans/other.md and plans/other.md'))
      .toEqual(['2026-10-12-dashboards.md', 'other.md']);
  });
  it('none', () => { expect(planRefsIn('nothing')).toEqual([]); });
});
```

- [ ] **Step 2:** `npx vitest run scripts/afk/planRefs.test.ts` -> FAIL.
- [ ] **Step 3: Implement `planRefs.mjs`.**
- [ ] **Step 4:** -> PASS.
- [ ] **Step 5: Commit**

```bash
P="scripts/afk/planRefs.mjs scripts/afk/planRefs.test.ts"
git add -- $P && git commit -m "feat(afk): plan references and spec-approved test" -- $P
```

---

### Task 9: The "decided" classifier

**Files:**
- Create: `scripts/afk/classify.mjs`
- Test: `scripts/afk/classify.test.ts`

```owned T9
scripts/afk/classify.mjs
scripts/afk/classify.test.ts
```

**Interfaces:**
- Produces: `classifyItem(text): {verdict:'ready'|'question'|'barred'; reasons: string[]}`. Order: barred first, then question, else ready. Reasons are stable codes: `barred:delete`, `barred:force-push`, `barred:cleanup`, `question:marker`, `question:needs-matt`, `question:mark`.
- Barred (case-insensitive): `\bdelet(e|ing)\b`, `\brm -rf?\b`, `\bRemove-Item\b`, `\bprune\b`, `force[- ]push`, `--force`, `reset --hard`, `branch -D` / `branch --delete` / `branch -d`, `worktree remove`, `\bcleanup\b`. False positives are accepted (held, never run).
- Question: a `?` anywhere; needs-Matt phrases (`ask Matt`, `needs? (a )?(fresh )?(go|approval)`, `Matt'?s? (call|decision|go|approval)`, `pending Matt`, `awaiting Matt`, `fresh go`, `all need Matt`); marker words `TBD`, `UNVERIFIED`, `unconfirmed`, `unclear`, `decide`, `open question`, `option(s)`, `either`, `whether`, `optional`, `maybe`, `consider`, `possibly`.

- [ ] **Step 1: Write the failing test.** Cases are taken verbatim from real handoffs (2026-11-04 handback and AFK handoffs) so the rules are checked against the text they will meet.

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { classifyItem } from './classify.mjs';

describe('classifyItem', () => {
  it.each([
    ['Delete .worktrees/collector-build: DECIDED option A (Matt, 2026-11-04) - leave it until the collector next restarts', 'barred'],
    ['Force-push the rebased branch', 'barred'],
    ['git branch -D feat/x after the merge', 'barred'],
    ['Ask Matt (one message) whether to push docs/afk-mode-design and open a docs-only PR; do not push without his go', 'question'],
    ['Tell Matt the outcome of step 1. If mostly `[]`, options B and C go to Matt, not decided here.', 'question'],
    ['Optional follow-up ticket: s14 sentence + parser nits. Do not push commits onto merged work.', 'question'],
    ['Which approach should the runner take?', 'question'],
    ['collector rebuild from merged master needs a fresh go', 'question'],
    ['Before planning Phase 2, verify the prototype: run git branch -a and check which branches are merged', 'ready'],
    ['Run npm test and fix the two failing starters tests in src/shared/dashboards', 'ready'],
    ['Build the APK for aethermobile with the titan IP', 'ready'],
  ])('%s -> %s', (text, verdict) => {
    expect(classifyItem(text).verdict).toBe(verdict);
  });

  it('barred beats question and reports why', () => {
    const r = classifyItem('Delete the worktree; ask Matt first?');
    expect(r.verdict).toBe('barred');
    expect(r.reasons[0]).toBe('barred:delete');
  });
  it('ready carries no reasons', () => {
    expect(classifyItem('Run npm test').reasons).toEqual([]);
  });
});
```

- [ ] **Step 2:** `npx vitest run scripts/afk/classify.test.ts` -> FAIL.
- [ ] **Step 3: Implement `classify.mjs`** with the two regex tables above.
- [ ] **Step 4:** -> PASS.
- [ ] **Step 5: Commit**

```bash
P="scripts/afk/classify.mjs scripts/afk/classify.test.ts"
git add -- $P && git commit -m "feat(afk): decided/question/barred item classifier" -- $P
```

---

### Task 10: Night-list compiler

**Files:**
- Create: `scripts/afk/compileNightList.mjs`
- Test: `scripts/afk/compileNightList.test.ts`

```owned T10
scripts/afk/compileNightList.mjs
scripts/afk/compileNightList.test.ts
```

**Interfaces:**
- Consumes: T7, T8, T9, T4 (`windowFor`). It does not use T11: the compiler sets `kind:'work'` for handoff/ledger items and `kind:'plan'` for named plans, with `artifact:null`; T13 upgrades `kind` to `'build'` (via `detectArtifact`) when it opens the night.
- Produces: `compileNightList({homeDir, projects: string[], plans?: string[], handoffs?: string[], repoRoots?: Record<string,string>, nowMs, maxAgeDays = 3, window = {start:'01:00', end:'07:00'}}): NightList`.
- `NightList = {v:1, createdAtMs, targetWindowStartMs, projects, warnings: string[], items: Item[]}` (the night id and the confirmation state are added by T13).
- `Item = {id, project, kind, artifact, title, source:{kind:'handoff'|'ledger'|'plan', file, n?}, verdict, reasons, planRef?:{file, specApproved}, confirmed:false, feasibility:null}`. `id` = first 12 hex of sha256 of `project|source.kind|normalised full text` (lowercase, whitespace collapsed); stable across recompiles. `title` = the first 140 characters of the normalised text. Items with the same id from two sources are de-duplicated (first wins).
- Handoff choice, per D3: newest eligible handoff by mtime per project (see D3 for the filters) plus `handoffs` paths; ledger = newest `ledger-*.md` within `maxAgeDays`. Handoffs with `headingNote` containing `need Matt` make every item `question` with reason `question:needs-matt`. Ledger `pending` items are `question`.
- Plans: for each plan file named in an item's text (`planRefsIn`) or in `plans`, look in `<repoRoots[project] ?? join(homeDir,'projects',project)>/docs/superpowers/plans/<file>`. Missing file: item becomes `question`, reason `plan-not-found`, plus a warning. Found: read its `**Spec:**` path (relative to the same repo root); spec missing or not approved: `question`, reason `spec-not-approved`; `planRef = {file, specApproved}`. A plan named by `plans` becomes its own item: `kind:'plan'`, title `Execute plan <file>`, `verdict` `ready` only if the spec is approved. **Checkboxes inside plans are never read.**
- A missing project handoff dir adds a warning and compiles the rest; the function never throws on missing inputs.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compileNightList } from './compileNightList.mjs';

const NOW = new Date(2026, 10, 4, 23, 0).getTime();
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'afk-compile-'));
  const put = (rel: string, text: string, ageDays = 0) => {
    const p = join(home, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text);
    const t = new Date(NOW - ageDays * 864e5); utimesSync(p, t, t); return p;
  };
  return { home, put };
}
const HANDOFF = '# H\n\n## Next steps\n1. Run npm test and fix the failing starters test\n2. Ask Matt whether to push\n3. Delete .worktrees/old\n\n## Decisions\n- x\n';
const base = (home: string, extra = {}) => ({ homeDir: home, projects: ['aether-os'], nowMs: NOW, ...extra });

describe('compileNightList', () => {
  it('compiles the newest eligible handoff and ledger todos, with verdicts', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/2026-11-04-new-handoff.md', HANDOFF);
    put('.claude/handoffs/aether-os/2026-10-20-old-handoff.md', '## Next steps\n1. stale item\n', 10);
    put('.claude/handoffs/aether-os/verdict-x.md', '## Next steps\n1. should be ignored\n');
    put('.claude/handoffs/aether-os/ledger-2026-11-04.md', '- [todo] Build the APK for aethermobile\n- [done] finished\n');
    const l = compileNightList(base(home));
    const byTitle = Object.fromEntries(l.items.map((i) => [i.title, i]));
    expect(byTitle['Run npm test and fix the failing starters test'].verdict).toBe('ready');
    expect(byTitle['Ask Matt whether to push'].verdict).toBe('question');
    expect(byTitle['Delete .worktrees/old'].verdict).toBe('barred');
    expect(byTitle['Build the APK for aethermobile'].source.kind).toBe('ledger');
    expect(l.items.some((i) => i.title.includes('stale') || i.title.includes('ignored'))).toBe(false);
  });

  it('stores signal not payload: basename source, short title, stable distinct ids, unconfirmed', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/h.md', '## Next steps\n1. ' + 'x'.repeat(300) + '\n');
    const a = compileNightList(base(home)); const b = compileNightList(base(home));
    expect(a.items[0].title.length).toBe(140);
    expect(a.items[0].source.file).toBe('h.md');
    expect(JSON.stringify(a)).not.toContain(home);
    expect(a.items[0].id).toMatch(/^[0-9a-f]{12}$/); expect(a.items[0].id).toBe(b.items[0].id);
    expect(a.items[0]).toMatchObject({ confirmed: false, feasibility: null });
  });

  it('de-duplicates the same text from handoff and ledger', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/h.md', '## Next steps\n1. Run npm test\n');
    put('.claude/handoffs/aether-os/ledger-2026-11-04.md', '- [todo] Run npm test\n');
    expect(compileNightList(base(home)).items.length).toBe(1);
  });

  it('heading "(all need Matt)" and ledger pending make questions', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/h.md', '## Next steps (all need Matt)\n1. Run npm test\n');
    put('.claude/handoffs/aether-os/ledger-2026-11-04.md', '- [pending Matt] restart collector\n');
    const l = compileNightList(base(home));
    expect(l.items.every((i) => i.verdict === 'question')).toBe(true);
  });

  it('plan reference: approved spec stays ready, unapproved or missing plan is a question', () => {
    const { home, put } = fixture();
    put('projects/aether-os/docs/superpowers/plans/p-ok.md', '# P\n**Spec:** `docs/superpowers/specs/ok.md`\n- [ ] unchecked step\n');
    put('projects/aether-os/docs/superpowers/specs/ok.md', '# S\nStatus: approved\n');
    put('projects/aether-os/docs/superpowers/plans/p-draft.md', '# P\n**Spec:** `docs/superpowers/specs/draft.md`\n');
    put('projects/aether-os/docs/superpowers/specs/draft.md', '# S\nStatus: DRAFT\n');
    put('.claude/handoffs/aether-os/h.md',
      '## Next steps\n1. Execute docs/superpowers/plans/p-ok.md\n2. Execute docs/superpowers/plans/p-draft.md\n3. Execute docs/superpowers/plans/gone.md\n');
    const [ok, draft, gone] = compileNightList(base(home)).items;
    expect(ok).toMatchObject({ verdict: 'ready', planRef: { file: 'p-ok.md', specApproved: true } });
    expect(draft.reasons).toContain('spec-not-approved');
    expect(gone.reasons).toContain('plan-not-found');
  });

  it('unchecked plan boxes alone put nothing on the list', () => {
    const { home, put } = fixture();
    put('projects/aether-os/docs/superpowers/plans/shipped.md', '**Spec:** `s.md`\n' + '- [ ] step\n'.repeat(50));
    put('.claude/handoffs/aether-os/h.md', '## Next steps\n1. Run npm test\n');
    expect(compileNightList(base(home)).items.map((i) => i.title)).toEqual(['Run npm test']);
  });

  it('a plan named by Matt becomes its own item', () => {
    const { home, put } = fixture();
    const plan = put('projects/aether-os/docs/superpowers/plans/named.md', '**Spec:** `docs/superpowers/specs/n.md`\n');
    put('projects/aether-os/docs/superpowers/specs/n.md', 'Status: approved\n');
    put('.claude/handoffs/aether-os/h.md', '## Next steps\n1. Run npm test\n');
    const l = compileNightList(base(home, { plans: [plan] }));
    expect(l.items.find((i) => i.kind === 'plan')).toMatchObject({ title: 'Execute plan named.md', verdict: 'ready' });
  });

  it('a project with no handoff folder warns instead of throwing; target window is the next 01:00', () => {
    const { home } = fixture();
    const l = compileNightList(base(home));
    expect(l.items).toEqual([]); expect(l.warnings.join(' ')).toContain('aether-os');
    expect(l.targetWindowStartMs).toBe(new Date(2026, 10, 5, 1, 0).getTime());
  });
});
```

- [ ] **Step 2:** `npx vitest run scripts/afk/compileNightList.test.ts` -> FAIL.
- [ ] **Step 3: Implement `compileNightList.mjs`.** Use `readdirSync` plus `statSync().mtimeMs`; unreadable files add a warning.
- [ ] **Step 4:** -> PASS.
- [ ] **Step 5: Commit**

```bash
P="scripts/afk/compileNightList.mjs scripts/afk/compileNightList.test.ts"
git add -- $P && git commit -m "feat(afk): night-list compiler with the decided test" -- $P
```

---

### Task 11: Build recipe table

**Files:**
- Create: `scripts/afk/recipes.mjs`
- Test: `scripts/afk/recipes.test.ts`

```owned T11
scripts/afk/recipes.mjs
scripts/afk/recipes.test.ts
```

**Interfaces:**
- Produces: `RECIPES` (object keyed `"<project>/<artifact>"`), `getRecipe(project, artifact): Recipe|null`, `detectArtifact(text): 'apk'|'installer'|null`.
- `Recipe = {cwd: string, argv: string[], requires: Requirement[], evidence: string, verified: boolean}`; `Requirement = {kind:'propKeys', file: string, keys: string[]} | {kind:'propPath', file: string, key: string} | {kind:'file', path: string} | {kind:'scratchDir'}`. Paths are repo-relative. `{SCRATCH}` in argv is a placeholder the runner fills.
- Rows: exactly the four in D4 (aether-os/installer, aether-os/apk, TarotApp/apk, TokenMonitor/installer). `verified:false` on all four (none has been run unattended). `evidence` quotes the file:line from D4.
- `detectArtifact`: `/\b(apk|aab)\b/i` -> `'apk'`; `/\b(exe|installer|setup)\b/i` -> `'installer'`; apk wins if both.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RECIPES, detectArtifact, getRecipe } from './recipes.mjs';

describe('recipes', () => {
  it('aethermobile APK bakes in the titan IP and runs in android/', () => {
    const r = getRecipe('aether-os', 'apk');
    expect(r?.cwd).toBe('android');
    expect(r?.argv).toContain('-PAETHER_TITAN_TAILNET_IP=100.84.175.105');
    const keys = r?.requires.flatMap((q) => (q.kind === 'propKeys' ? q.keys : []));
    expect(keys).toEqual(expect.arrayContaining(['AETHER_KEYSTORE_PASSWORD', 'AETHER_KEY_ALIAS', 'AETHER_KEY_PASSWORD']));
    expect(r?.requires.some((q) => q.kind === 'propPath' && q.key === 'AETHER_KEYSTORE_PATH')).toBe(true);
  });
  it('Aether packaging builds outside the dev tree', () => {
    const r = getRecipe('aether-os', 'installer');
    expect(r?.argv.join(' ')).toContain('-c.directories.output={SCRATCH}');
    expect(r?.requires).toContainEqual({ kind: 'scratchDir' });
  });
  it('TokenMonitor needs the pfx password file present', () => {
    expect(getRecipe('TokenMonitor', 'installer')?.requires).toContainEqual({ kind: 'file', path: 'codesign/pfx-password.txt' });
  });
  it.each(['MobileCrawler', 'nmmtools', 'unknown-project'])('%s has no recipe', (p) => {
    expect(getRecipe(p, 'apk')).toBeNull(); expect(getRecipe(p, 'installer')).toBeNull();
  });
  it('every recipe cites evidence and is unverified', () => {
    for (const [k, r] of Object.entries(RECIPES)) {
      expect(r.evidence.length, k).toBeGreaterThan(10); expect(r.verified, k).toBe(false);
    }
  });
  it.each([
    ['Build the APK for aethermobile', 'apk'], ['cut a new installer', 'installer'],
    ['produce the exe', 'installer'], ['ship apk and installer', 'apk'], ['fix the tests', null],
  ])('detectArtifact %j -> %s', (t, want) => { expect(detectArtifact(t)).toBe(want); });
});
```

- [ ] **Step 2:** `npx vitest run scripts/afk/recipes.test.ts` -> FAIL.
- [ ] **Step 3: Implement `recipes.mjs`** from the D4 table. The Titan IP is a Tailscale address, not a secret (memory `aether-android-titan-ip-build-prop`).
- [ ] **Step 4:** -> PASS.
- [ ] **Step 5: Commit**

```bash
P="scripts/afk/recipes.mjs scripts/afk/recipes.test.ts"
git add -- $P && git commit -m "feat(afk): per-project build recipe table" -- $P
```

---

### Task 12: Feasibility check (presence only)

**Files:**
- Create: `scripts/afk/feasibility.mjs`
- Test: `scripts/afk/feasibility.test.ts`

```owned T12
scripts/afk/feasibility.mjs
scripts/afk/feasibility.test.ts
```

**Interfaces:**
- Consumes: `getRecipe`, `detectArtifact` (T11).
- Produces: `checkFeasibility(item, probes): {ok:boolean; checks:{name:string; ok:boolean; detail:string}[]; warnings:string[]}`; `realProbes({homeDir, repoRoots = {}, env = process.env}): Probes`.
- `Probes = {repoRoot(project): string|null, fileExists(absPath): boolean, propKeysPresent(absFile, keys): Record<string,boolean>, propPathExists(absFile, key): boolean}`.
- Behaviour: an item whose `kind` is not `'build'` returns `{ok:true, checks:[], warnings:[]}`. A build item with no recipe returns `ok:false` with check `no build recipe for <project>/<artifact>`. Otherwise one check per requirement; `ok` = all pass; an unverified recipe adds the warning `recipe not yet verified unattended`. **Details name keys, never values.** `propKeysPresent` is true for a key that has a non-empty value in the file OR a non-empty entry in `env` (Gradle's `signingValue` order, `android/app/build.gradle:14`); comment lines and empty values are false. `propPathExists` reads one value only to test that the path exists and never returns it. `realProbes.repoRoot` = `repoRoots[project] ?? join(homeDir,'projects',project)` if it exists, else null.
- Item `kind` is `'build'` when `detectArtifact(item.title)` is non-null; T13 sets it on open.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFeasibility, realProbes } from './feasibility.mjs';

const apk = { project: 'aether-os', kind: 'build', artifact: 'apk', title: 'Build the APK' };
const probes = (over: Record<string, unknown> = {}) => ({
  repoRoot: () => 'C:/r', fileExists: () => true,
  propKeysPresent: (_f: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, true])),
  propPathExists: () => true, ...over,
});

describe('checkFeasibility (fake probes)', () => {
  it('non-build items are trivially feasible', () => {
    expect(checkFeasibility({ ...apk, kind: 'work' }, probes())).toEqual({ ok: true, checks: [], warnings: [] });
  });
  it('a build item with no recipe is blocked', () => {
    const r = checkFeasibility({ ...apk, project: 'MobileCrawler' }, probes());
    expect(r.ok).toBe(false); expect(r.checks[0].detail).toContain('no build recipe');
  });
  it('all present: ok, with the unverified-recipe warning', () => {
    const r = checkFeasibility(apk, probes());
    expect(r.ok).toBe(true); expect(r.warnings.join(' ')).toContain('not yet verified');
  });
  it('a missing signing key blocks and names the KEY only', () => {
    const r = checkFeasibility(apk, probes({ propKeysPresent: (_f: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, k !== 'AETHER_KEY_ALIAS'])) }));
    expect(r.ok).toBe(false); expect(JSON.stringify(r)).toContain('AETHER_KEY_ALIAS');
  });
  it('an unresolvable repo root blocks', () => {
    expect(checkFeasibility(apk, probes({ repoRoot: () => null })).ok).toBe(false);
  });
});

describe('realProbes', () => {
  it('reports presence and never leaks a value', () => {
    const home = mkdtempSync(join(tmpdir(), 'afk-feas-'));
    const root = join(home, 'projects', 'aether-os'); mkdirSync(join(root, 'android'), { recursive: true });
    const ks = join(home, 'ks.jks'); writeFileSync(ks, 'x');
    writeFileSync(join(root, 'android', 'local.properties'),
      `# AETHER_KEY_ALIAS=commented\nAETHER_KEYSTORE_PASSWORD=S3CR3T-SENTINEL\nAETHER_KEY_ALIAS=\nAETHER_KEYSTORE_PATH=${ks.replace(/\\/g, '/')}\n`);
    const p = realProbes({ homeDir: home, env: {} });
    const file = join(root, 'android', 'local.properties');
    expect(p.repoRoot('aether-os')).toBe(root);
    expect(p.propKeysPresent(file, ['AETHER_KEYSTORE_PASSWORD', 'AETHER_KEY_ALIAS', 'AETHER_KEY_PASSWORD']))
      .toEqual({ AETHER_KEYSTORE_PASSWORD: true, AETHER_KEY_ALIAS: false, AETHER_KEY_PASSWORD: false });
    expect(p.propPathExists(file, 'AETHER_KEYSTORE_PATH')).toBe(true);
    const full = checkFeasibility(apk, p);
    expect(JSON.stringify(full)).not.toContain('S3CR3T-SENTINEL');
    expect(JSON.stringify(full)).not.toContain(ks);
  });
  it('an env entry satisfies a key absent from the file', () => {
    const home = mkdtempSync(join(tmpdir(), 'afk-feas-'));
    const p = realProbes({ homeDir: home, env: { AETHER_KEY_PASSWORD: 'x' } });
    expect(p.propKeysPresent(join(home, 'missing.properties'), ['AETHER_KEY_PASSWORD'])).toEqual({ AETHER_KEY_PASSWORD: true });
  });
});
```

- [ ] **Step 2:** `npx vitest run scripts/afk/feasibility.test.ts` -> FAIL.
- [ ] **Step 3: Implement `feasibility.mjs`.** Any read error is a `false`, never a thrown message containing file content.
- [ ] **Step 4:** -> PASS.
- [ ] **Step 5: Commit**

```bash
P="scripts/afk/feasibility.mjs scripts/afk/feasibility.test.ts"
git add -- $P && git commit -m "feat(afk): presence-only feasibility probes for APK/EXE items" -- $P
```

---

### Task 13: Night workspace (open, annotate, confirm, amend)

**Files:**
- Create: `scripts/afk/nightList.mjs`
- Test: `scripts/afk/nightList.test.ts`

```owned T13
scripts/afk/nightList.mjs
scripts/afk/nightList.test.ts
```

**Interfaces:**
- Consumes: T3 (`readLiveTerms`), T4, T1 (`applyAmendments`), T6 (`readApproval`), T11 (`detectArtifact`), T2.
- Produces:
  - `openNight(aetherDir, compiled, nowMs): {nightId, list}`. Reuses the newest night that is current (`isNightCurrent`) and has NO approval, else creates a new id. On reuse, replaces `items` with the new compile but keeps `confirmed:true` for ids still present (confirmations for vanished ids are dropped). Sets `kind:'build'` and `artifact` on items where `detectArtifact(title)` is non-null (and `kind !== 'plan'`). The stored list gains `nightId` and `amendments: {}` (kept on reuse).
  - `readNightList(aetherDir, nightId): NightListFile|null`.
  - `setFeasibility(aetherDir, nightId, results: Record<itemId, FeasibilityResult>): void`.
  - `confirmItems(aetherDir, nightId, ids): {confirmed: string[]; refused: {id: string; reason: string}[]}`. Refuses: unknown id (`unknown`), verdict not `ready` (`not-ready:<verdict>`), build item without `feasibility.ok === true` (`feasibility`), any id once `approval.json` exists (`already-approved`). Writes atomically.
  - `amendNight(aetherDir, nightId, patch): {ok:boolean; errors: string[]}`. Validates `applyAmendments(readLiveTerms().terms, {...existing, ...patch})`; stores the merged patch in `list.amendments`; refuses after approval.
  - `latestOpenNight(aetherDir, nowMs): string|null`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TERMS } from './terms.mjs';
import { writeApproval } from './approval.mjs';
import { amendNight, confirmItems, latestOpenNight, openNight, readNightList, setFeasibility } from './nightList.mjs';

const NOW = new Date(2026, 10, 4, 23, 0).getTime();
const tmp = () => mkdtempSync(join(tmpdir(), 'afk-night-'));
const it1 = (id: string, title: string, verdict = 'ready', extra = {}) =>
  ({ id, project: 'aether-os', kind: 'work', artifact: null, title, source: { kind: 'handoff', file: 'h.md' }, verdict, reasons: [], confirmed: false, feasibility: null, ...extra });
const compiled = (items: unknown[]) => ({ v: 1, createdAtMs: NOW, targetWindowStartMs: new Date(2026, 10, 5, 1).getTime(), projects: ['aether-os'], warnings: [], items });

describe('openNight', () => {
  it('creates a night and tags build items', () => {
    const d = tmp();
    const { nightId, list } = openNight(d, compiled([it1('a'.repeat(12), 'Build the APK'), it1('b'.repeat(12), 'Run npm test')]), NOW);
    expect(nightId).toMatch(/^n\d{8}T\d{6}$/);
    expect(list.items.map((i: any) => [i.kind, i.artifact])).toEqual([['build', 'apk'], ['work', null]]);
    expect(readNightList(d, nightId)?.nightId).toBe(nightId);
  });
  it('re-compiling the same open night keeps confirmations for surviving ids only', () => {
    const d = tmp(); const A = 'a'.repeat(12), B = 'b'.repeat(12);
    const { nightId } = openNight(d, compiled([it1(A, 'Run npm test'), it1(B, 'Fix lint')]), NOW);
    confirmItems(d, nightId, [A, B]);
    const again = openNight(d, compiled([it1(A, 'Run npm test'), it1('c'.repeat(12), 'New one')]), NOW + 1000);
    expect(again.nightId).toBe(nightId);
    expect(again.list.items.map((i: any) => [i.id.slice(0, 1), i.confirmed])).toEqual([['a', true], ['c', false]]);
  });
  it('an approved night is never reopened', () => {
    const d = tmp(); const { nightId } = openNight(d, compiled([it1('a'.repeat(12), 'x')]), NOW);
    writeApproval(d, nightId, { approvedAtMs: NOW, termsSha256: 'h', items: [], held: [] });
    expect(openNight(d, compiled([it1('a'.repeat(12), 'x')]), NOW + 5000).nightId).not.toBe(nightId);
    expect(latestOpenNight(d, NOW + 6000)).not.toBe(nightId);
  });
});

describe('confirmItems', () => {
  it('refuses unknown, question, barred and unfeasible build items', () => {
    const d = tmp();
    const ids = ['a', 'b', 'c', 'd'].map((c) => c.repeat(12));
    const { nightId } = openNight(d, compiled([it1(ids[0], 'Run npm test'), it1(ids[1], 'Ask?', 'question'), it1(ids[2], 'Delete x', 'barred'), it1(ids[3], 'Build the APK')]), NOW);
    const r = confirmItems(d, nightId, [...ids, 'f'.repeat(12)]);
    expect(r.confirmed).toEqual([ids[0]]);
    expect(Object.fromEntries(r.refused.map((x) => [x.id.slice(0, 1), x.reason]))).toEqual({
      b: 'not-ready:question', c: 'not-ready:barred', d: 'feasibility', f: 'unknown',
    });
  });
  it('confirms a build item once feasibility passed, and refuses after approval', () => {
    const d = tmp(); const A = 'a'.repeat(12);
    const { nightId } = openNight(d, compiled([it1(A, 'Build the APK')]), NOW);
    setFeasibility(d, nightId, { [A]: { ok: true, checks: [], warnings: [] } });
    expect(confirmItems(d, nightId, [A]).confirmed).toEqual([A]);
    writeApproval(d, nightId, { approvedAtMs: NOW, termsSha256: 'h', items: [], held: [] });
    expect(confirmItems(d, nightId, [A]).refused[0].reason).toBe('already-approved');
  });
});

describe('amendNight', () => {
  it('stores a valid amendment and never touches live terms', () => {
    const d = tmp(); const { nightId } = openNight(d, compiled([]), NOW);
    expect(amendNight(d, nightId, { opusEscalation: true }).ok).toBe(true);
    expect(readNightList(d, nightId)?.amendments).toEqual({ opusEscalation: true });
  });
  it('rejects delete and an incoherent merge', () => {
    const d = tmp(); const { nightId } = openNight(d, compiled([]), NOW);
    expect(amendNight(d, nightId, { delete: true }).ok).toBe(false);
    expect(amendNight(d, nightId, { fableElevation: true }).ok).toBe(false);
    expect(readNightList(d, nightId)?.amendments).toEqual({});
  });
});
```

(`DEFAULT_TERMS` import is for the builder's convenience in extra cases; unused imports are fine in tests but remove it if the linter complains.)

- [ ] **Step 2:** `npx vitest run scripts/afk/nightList.test.ts` -> FAIL.
- [ ] **Step 3: Implement `nightList.mjs`.**
- [ ] **Step 4:** -> PASS.
- [ ] **Step 5: Commit**

```bash
P="scripts/afk/nightList.mjs scripts/afk/nightList.test.ts"
git add -- $P && git commit -m "feat(afk): night workspace with confirm, feasibility and amendments" -- $P
```

---

### Task 14: Approval flow (TTY and phrase gate)

**Files:**
- Create: `scripts/afk/approveFlow.mjs`
- Test: `scripts/afk/approveFlow.test.ts`

```owned T14
scripts/afk/approveFlow.mjs
scripts/afk/approveFlow.test.ts
```

**Interfaces:**
- Consumes: T1, T3, T5, T6, T13.
- Produces: `expectedPhrase(termsSha256): string` = `APPROVE ` + first 8 hex; `approveNight({aetherDir, nightId, nowMs, isTty, readLine, print}): Promise<{ok:true; approval} | {ok:false; code:'not-tty'|'already-approved'|'terms-invalid'|'no-confirmed-items'|'phrase-mismatch'|'no-such-night'; message}>`.
- Order (each early return writes nothing): (1) `!isTty` -> `not-tty`, `print` and `readLine` never called; (2) night exists; (3) no existing approval; (4) effective terms = `applyAmendments(readLiveTerms().terms, list.amendments)`, invalid -> `terms-invalid`; (5) >= 1 confirmed item; (6) `print` a summary: every effective term, which differ from defaults, `delete: NOT ALLOWED`, `force-push: NOT ALLOWED`, each confirmed item's id and title, each held item with its reason; (7) `readLine("Type exactly: <phrase>")` and compare after trim; (8) write snapshot, approval (`items` = confirmed items only, `held` = the rest), then last-approved, in that order.
- `held[].reason` = the first of `reasons` or `not-confirmed`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TERMS, termsSha256 } from './terms.mjs';
import { writeLiveTerms, termsPath } from './termsStore.mjs';
import { nightPaths } from './nights.mjs';
import { amendNight, confirmItems, openNight } from './nightList.mjs';
import { readApproval, readLastApproved } from './approval.mjs';
import { readSnapshot } from './snapshot.mjs';
import { approveNight, expectedPhrase } from './approveFlow.mjs';

const NOW = new Date(2026, 10, 4, 23, 0).getTime();
const tmp = () => mkdtempSync(join(tmpdir(), 'afk-approve-'));
const A = 'a'.repeat(12), B = 'b'.repeat(12);
const mk = (id: string, title: string, verdict = 'ready') =>
  ({ id, project: 'aether-os', kind: 'work', artifact: null, title, source: { kind: 'handoff', file: 'h.md' }, verdict, reasons: verdict === 'ready' ? [] : ['question:marker'], confirmed: false, feasibility: null });
function setup() {
  const d = tmp();
  const { nightId } = openNight(d, { v: 1, createdAtMs: NOW, targetWindowStartMs: new Date(2026, 10, 5, 1).getTime(), projects: ['aether-os'], warnings: [], items: [mk(A, 'Run npm test'), mk(B, 'Ask Matt?', 'question')] } as any, NOW);
  confirmItems(d, nightId, [A]);
  return { d, nightId };
}
const run = (d: string, nightId: string, over: Record<string, unknown> = {}) => {
  const printed: string[] = []; let asked = 0;
  const p = approveNight({ aetherDir: d, nightId, nowMs: NOW, isTty: true, print: (s: string) => printed.push(s), readLine: async () => { asked++; return expectedPhrase(termsSha256(DEFAULT_TERMS)); }, ...over });
  return { p, printed, asked: () => asked };
};

describe('approveNight', () => {
  it('without a TTY refuses, prints nothing, asks nothing, writes nothing', async () => {
    const { d, nightId } = setup(); const r = run(d, nightId, { isTty: false });
    expect(await r.p).toMatchObject({ ok: false, code: 'not-tty' });
    expect(r.printed).toEqual([]); expect(r.asked()).toBe(0);
    expect(existsSync(nightPaths(d, nightId).snapshot)).toBe(false);
  });
  it('refuses when nothing is confirmed', async () => {
    const d = tmp();
    const { nightId } = openNight(d, { v: 1, createdAtMs: NOW, targetWindowStartMs: new Date(2026, 10, 5, 1).getTime(), projects: [], warnings: [], items: [mk(A, 'x')] } as any, NOW);
    expect(await run(d, nightId).p).toMatchObject({ ok: false, code: 'no-confirmed-items' });
  });
  it('a wrong phrase writes nothing', async () => {
    const { d, nightId } = setup();
    expect(await run(d, nightId, { readLine: async () => 'yes' }).p).toMatchObject({ ok: false, code: 'phrase-mismatch' });
    expect(readApproval(d, nightId)).toBeNull();
  });
  it('the right phrase writes snapshot, approval and last-approved', async () => {
    const { d, nightId } = setup(); const r = run(d, nightId);
    const res = await r.p;
    expect(res.ok).toBe(true);
    const appr = readApproval(d, nightId);
    expect(appr?.items.map((i: any) => i.id)).toEqual([A]);
    expect(appr?.held.map((h: any) => h.id)).toEqual([B]);
    expect(readSnapshot(d, nightId).ok).toBe(true);
    expect(readLastApproved(d)?.nightId).toBe(nightId);
    const text = r.printed.join('\n');
    expect(text).toContain('Run npm test'); expect(text).toContain('delete: NOT ALLOWED'); expect(text).toContain('force-push: NOT ALLOWED');
  });
  it('a one-night amendment lands in the snapshot but not the live terms file', async () => {
    const { d, nightId } = setup();
    writeLiveTerms(d, DEFAULT_TERMS);
    const before = readFileSync(termsPath(d), 'utf8');
    amendNight(d, nightId, { opusEscalation: true });
    const amended = { ...DEFAULT_TERMS, opusEscalation: true };
    const res = await run(d, nightId, { readLine: async () => expectedPhrase(termsSha256(amended)) }).p;
    expect(res.ok).toBe(true);
    const snap = readSnapshot(d, nightId);
    expect(snap.ok && snap.snapshot.terms.opusEscalation).toBe(true);
    expect(snap.ok && snap.snapshot.liveSha256).toBe(termsSha256(DEFAULT_TERMS));
    expect(readFileSync(termsPath(d), 'utf8')).toBe(before);
  });
  it('a second approval is refused', async () => {
    const { d, nightId } = setup(); await run(d, nightId).p;
    expect(await run(d, nightId).p).toMatchObject({ ok: false, code: 'already-approved' });
  });
});
```

- [ ] **Step 2:** `npx vitest run scripts/afk/approveFlow.test.ts` -> FAIL.
- [ ] **Step 3: Implement `approveFlow.mjs`.** The phrase includes the effective-terms hash prefix so approving a stale printed summary after the terms changed fails.
- [ ] **Step 4:** -> PASS.
- [ ] **Step 5: Commit**

```bash
P="scripts/afk/approveFlow.mjs scripts/afk/approveFlow.test.ts"
git add -- $P && git commit -m "feat(afk): TTY-gated approval flow writing snapshot and approval record" -- $P
```

---

### Task 15: `resolveNightPlan`, the Phase 2 entry point

**Files:**
- Create: `scripts/afk/resolvePlan.mjs`
- Test: `scripts/afk/resolvePlan.test.ts`

```owned T15
scripts/afk/resolvePlan.mjs
scripts/afk/resolvePlan.test.ts
```

**Interfaces:**
- Consumes: T4, T5, T6, T13.
- Produces: `resolveNightPlan({aetherDir, nowMs}): {kind:'approved'|'unfinished'|'none'; nightId: string|null; terms: Terms|null; termsSha256: string|null; items: Item[]; held: {id,title,verdict,reason}[]; reason: string}`. Never throws.
- Rules: walk `listNightIds` newest first, take the first night whose list exists and `isNightCurrent(nowMs, list.targetWindowStartMs)` (a night with a torn or unreadable list is skipped). Then:
  - **approved**: `approval.json` exists, its snapshot verifies (T5) and `snapshot.termsSha256 === approval.termsSha256`. `terms` from the snapshot, `items` and `held` from the approval record. **The night-list file is not read for items.** Snapshot failure -> `kind:'none'`, `reason` names the snapshot.
  - **unfinished**: no approval, >= 1 `confirmed` item in the list, and `readLastApproved` exists: `terms` = last-approved snapshot terms (NOT live terms, NOT `list.amendments`); `items` = the confirmed items; `held` = everything else (`reason`: its first reason or `not-confirmed`). No last-approved -> `none`, reason `no last-approved terms`.
  - otherwise `none`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TERMS, termsSha256 } from './terms.mjs';
import { writeLiveTerms } from './termsStore.mjs';
import { nightPaths } from './nights.mjs';
import { amendNight, confirmItems, openNight, readNightList } from './nightList.mjs';
import { approveNight, expectedPhrase } from './approveFlow.mjs';
import { resolveNightPlan } from './resolvePlan.mjs';

const NOW = new Date(2026, 10, 4, 23, 0).getTime();
const WIN = new Date(2026, 10, 5, 1, 0).getTime();
const tmp = () => mkdtempSync(join(tmpdir(), 'afk-resolve-'));
const A = 'a'.repeat(12), B = 'b'.repeat(12);
const mk = (id: string, title: string) => ({ id, project: 'aether-os', kind: 'work', artifact: null, title, source: { kind: 'handoff', file: 'h.md' }, verdict: 'ready', reasons: [], confirmed: false, feasibility: null });
const open = (d: string, nowMs: number, ids = [A, B]) =>
  openNight(d, { v: 1, createdAtMs: nowMs, targetWindowStartMs: WIN, projects: ['aether-os'], warnings: [], items: ids.map((i) => mk(i, `item ${i[0]}`)) } as any, nowMs).nightId;
const approve = (d: string, nightId: string, terms = DEFAULT_TERMS) =>
  approveNight({ aetherDir: d, nightId, nowMs: NOW, isTty: true, print: () => {}, readLine: async () => expectedPhrase(termsSha256(terms)) });

describe('resolveNightPlan', () => {
  it('approved: terms from the snapshot, items from the approval record only', async () => {
    const d = tmp(); const n = open(d, NOW); confirmItems(d, n, [A]); await approve(d, n);
    // tamper: mark B confirmed in the night list after approval
    const p = nightPaths(d, n).list; const j = JSON.parse(readFileSync(p, 'utf8')); j.items[1].confirmed = true; writeFileSync(p, JSON.stringify(j));
    const r = resolveNightPlan({ aetherDir: d, nowMs: WIN });
    expect(r.kind).toBe('approved'); expect(r.items.map((i: any) => i.id)).toEqual([A]); expect(r.held.map((h: any) => h.id)).toEqual([B]);
    expect(r.terms).toEqual(DEFAULT_TERMS);
  });
  it('a tampered snapshot yields none and names the snapshot', async () => {
    const d = tmp(); const n = open(d, NOW); confirmItems(d, n, [A]); await approve(d, n);
    const p = nightPaths(d, n).snapshot; const j = JSON.parse(readFileSync(p, 'utf8')); j.terms.opusEscalation = true; writeFileSync(p, JSON.stringify(j));
    const r = resolveNightPlan({ aetherDir: d, nowMs: WIN });
    expect(r.kind).toBe('none'); expect(r.reason).toMatch(/snapshot/i); expect(r.items).toEqual([]);
  });
  it('unfinished: last-approved terms, confirmed items only, amendments and live edits ignored', async () => {
    const d = tmp();
    const n1 = open(d, NOW - 864e5); confirmItems(d, n1, [A]); await approve(d, n1);    // yesterday approved on defaults
    writeLiveTerms(d, { ...DEFAULT_TERMS, opusEscalation: true });                       // live edited since
    const n2 = open(d, NOW); confirmItems(d, n2, [A]); amendNight(d, n2, { opusEscalation: true });
    const r = resolveNightPlan({ aetherDir: d, nowMs: WIN });
    expect(r.kind).toBe('unfinished'); expect(r.nightId).toBe(n2);
    expect(r.terms?.opusEscalation).toBe(false);
    expect(r.items.map((i: any) => i.id)).toEqual([A]); expect(r.held.map((h: any) => h.id)).toEqual([B]);
    expect(readNightList(d, n2)?.amendments).toEqual({ opusEscalation: true });
  });
  it('unfinished with no last-approved terms runs nothing', () => {
    const d = tmp(); const n = open(d, NOW); confirmItems(d, n, [A]);
    expect(resolveNightPlan({ aetherDir: d, nowMs: WIN })).toMatchObject({ kind: 'none', reason: expect.stringMatching(/last-approved/) });
  });
  it('nothing confirmed runs nothing', () => {
    const d = tmp(); open(d, NOW);
    expect(resolveNightPlan({ aetherDir: d, nowMs: WIN }).kind).toBe('none');
  });
  it('a stale night (more than 12h past its window start) is ignored', async () => {
    const d = tmp(); const n = open(d, NOW); confirmItems(d, n, [A]); await approve(d, n);
    expect(resolveNightPlan({ aetherDir: d, nowMs: WIN + 12 * 3600e3 + 1 }).kind).toBe('none');
  });
  it('an empty directory is none, not an error', () => {
    expect(resolveNightPlan({ aetherDir: tmp(), nowMs: NOW }).kind).toBe('none');
  });
});
```

- [ ] **Step 2:** `npx vitest run scripts/afk/resolvePlan.test.ts` -> FAIL.
- [ ] **Step 3: Implement `resolvePlan.mjs`.**
- [ ] **Step 4:** -> PASS.
- [ ] **Step 5: Commit**

```bash
P="scripts/afk/resolvePlan.mjs scripts/afk/resolvePlan.test.ts"
git add -- $P && git commit -m "feat(afk): resolveNightPlan, the approved/unfinished/none entry point" -- $P
```

---

### Task 16: Deny-rule builder

**Files:**
- Create: `scripts/afk/denyRules.mjs`
- Test: `scripts/afk/denyRules.test.ts`

```owned T16
scripts/afk/denyRules.mjs
scripts/afk/denyRules.test.ts
```

**Interfaces:**
- Consumes: `DEFAULT_TERMS` shape (T1).
- Produces: `buildDenyRules(terms): string[]` in Claude Code permission-rule syntax (the same strings the prototype used, `away-cmd.ps1:27-39`), de-duplicated, stable order.
- Always: `Edit(~/.aether-os/afk/**)`, `Write(~/.aether-os/afk/**)`, `Edit(~/.claude/away*)`, `Write(~/.claude/away*)`; delete verbs `Bash(rm:*)`, `Bash(rmdir:*)`, `Bash(del:*)`, `Bash(rd:*)`, `Bash(erase:*)`, `Bash(Remove-Item:*)`, `Bash(ri:*)`, `Bash(git clean:*)`, `Bash(git rm:*)`, `Bash(git branch -D:*)`, `Bash(git branch -d:*)`, `Bash(git branch --delete:*)`, `Bash(git worktree remove:*)`, `Bash(git worktree prune:*)`; force-push `Bash(git push --force:*)`, `Bash(git push -f:*)`, `Bash(git push --force-with-lease:*)`, `Bash(git push --delete:*)`.
- Conditional: `terms.push === false` adds `Bash(git push:*)`; `terms.merge === 'off'` adds `Bash(git merge:*)` and `Bash(gh pr merge:*)`. With the defaults NONE of the push/merge/`gh` rules appear (design 5 supersedes the prototype's blanket denial).
- Limits (stated in the module header and in RISKS): prefix rules cannot catch `git push origin +main` or `git push origin :branch`; the existing Safety Net hook is the second layer for those. Bash redirection into the terms file is not expressible as a rule. `git rm` is listed because deletion is barred; whether removing a tracked file inside a spec'd commit counts is OPEN for Matt.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMS } from './terms.mjs';
import { buildDenyRules } from './denyRules.mjs';

describe('buildDenyRules', () => {
  const base = buildDenyRules(DEFAULT_TERMS);
  it('protects the terms dir and the prototype state files', () => {
    expect(base).toEqual(expect.arrayContaining([
      'Edit(~/.aether-os/afk/**)', 'Write(~/.aether-os/afk/**)', 'Edit(~/.claude/away*)', 'Write(~/.claude/away*)',
    ]));
  });
  it('always bars delete verbs and force-push variants', () => {
    expect(base).toEqual(expect.arrayContaining([
      'Bash(rm:*)', 'Bash(Remove-Item:*)', 'Bash(git clean:*)', 'Bash(git branch -D:*)', 'Bash(git worktree remove:*)',
      'Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git push --force-with-lease:*)', 'Bash(git push --delete:*)',
    ]));
  });
  it('does NOT carry the prototype blanket push/merge/gh denial under the defaults', () => {
    for (const r of ['Bash(git push:*)', 'Bash(git merge:*)', 'Bash(gh:*)', 'Bash(gh pr merge:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)'])
      expect(base).not.toContain(r);
  });
  it('push:false and merge:off add the matching rules', () => {
    const r = buildDenyRules({ ...DEFAULT_TERMS, push: false, merge: 'off' });
    expect(r).toEqual(expect.arrayContaining(['Bash(git push:*)', 'Bash(git merge:*)', 'Bash(gh pr merge:*)']));
  });
  it('has no duplicates and never mentions bypass', () => {
    expect(new Set(base).size).toBe(base.length);
    expect(JSON.stringify(base).toLowerCase()).not.toContain('bypass');
  });
});
```

- [ ] **Step 2:** `npx vitest run scripts/afk/denyRules.test.ts` -> FAIL.
- [ ] **Step 3: Implement `denyRules.mjs`.**
- [ ] **Step 4:** -> PASS.
- [ ] **Step 5: Commit**

```bash
P="scripts/afk/denyRules.mjs scripts/afk/denyRules.test.ts"
git add -- $P && git commit -m "feat(afk): terms-derived deny-rule builder" -- $P
```

---

### Task 17: CLI verbs and the TTY gate

**Files:**
- Create: `scripts/afk/cli.mjs`, `scripts/afk/afk.mjs`
- Test: `scripts/afk/cli.test.ts`

```owned T17
scripts/afk/cli.mjs
scripts/afk/afk.mjs
scripts/afk/cli.test.ts
```

**Interfaces:**
- `cli.mjs` exports `VERBS` (array of verb names), `TTY_VERBS = ['terms set','amend','confirm','approve']` and `main(argv, deps): Promise<number>` with `deps = {homeDir, nowMs, isTty, readLine, print, env}`. `afk.mjs` is the executable entry only: reads `os.homedir()`, `Date.now()`, `process.stdin.isTTY && process.stdout.isTTY`, a `readline` question helper, then `process.exit(await main(...))`. Shebang `#!/usr/bin/env node`.
- Verbs: `terms show`; `terms set <key> <value>` (TTY; keys: any amendable key; `window.start`/`window.end` also accepted; booleans `true|false`; `delete`/`forcePush`/`notifications` refused with exit 4); `compile --project <leaf>... [--plan <path>...] [--handoff <path>...] [--max-age-days N] [--json]` (read-only inputs, writes the night workspace via `openNight`; prints the items grouped ready/question/barred with ids and the night id); `feasibility [--night <id>]` (runs `realProbes`, stores via `setFeasibility`, prints per item); `confirm <id>... | --all-ready` (TTY); `amend <key> <value>` (TTY); `approve [--night <id>]` (TTY); `plan [--json]` (prints `resolveNightPlan` for now); `deny-rules` (prints `buildDenyRules(readLiveTerms().terms)` as a JSON array); `install-skill` (T19 wires it; here it exits 4 `not available yet`).
- Exit codes: 0 ok, 2 usage/unknown verb, 3 TTY required and absent (nothing written, nothing read from stdin), 4 refused or invalid, 1 unexpected error (message only, no stack with paths).
- `--night` defaults to `latestOpenNight`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TTY_VERBS, VERBS, main } from './cli.mjs';
import { readLiveTerms, termsPath } from './termsStore.mjs';

const entry = fileURLToPath(new URL('./afk.mjs', import.meta.url));
const tmpHome = () => mkdtempSync(join(tmpdir(), 'afk-cli-'));
const run = (home: string, args: string[]) =>
  spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', input: '', env: { ...process.env, HOME: home, USERPROFILE: home } });
const aether = (home: string) => join(home, '.aether-os');

describe('TTY gate (spawned, piped stdio)', () => {
  it.each([
    [['terms', 'set', 'opusEscalation', 'true']],
    [['amend', 'opusEscalation', 'true']],
    [['confirm', '--all-ready']],
    [['approve']],
  ])('%j exits 3 and writes nothing', (args) => {
    const home = tmpHome(); const r = run(home, args);
    expect(r.status).toBe(3);
    expect(existsSync(aether(home))).toBe(false);
  });
});

describe('read verbs (spawned)', () => {
  it('terms show prints defaults and the hash; delete is shown as not allowed', () => {
    const r = run(tmpHome(), ['terms', 'show']);
    expect(r.status).toBe(0); expect(r.stdout).toMatch(/[0-9a-f]{64}/); expect(r.stdout).toContain('delete: NOT ALLOWED');
  });
  it('plan with no nights is none', () => {
    const r = run(tmpHome(), ['plan', '--json']);
    expect(r.status).toBe(0); expect(JSON.parse(r.stdout).kind).toBe('none');
  });
  it('deny-rules prints a JSON array', () => {
    const r = run(tmpHome(), ['deny-rules']);
    expect(JSON.parse(r.stdout)).toContain('Bash(rm:*)');
  });
  it('unknown verb exits 2', () => { expect(run(tmpHome(), ['frobnicate']).status).toBe(2); });
  it('compile writes a night workspace under ~/.aether-os/afk/nights', () => {
    const home = tmpHome(); const d = join(home, '.claude', 'handoffs', 'p'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'h.md'), '## Next steps\n1. Run npm test\n');
    const r = run(home, ['compile', '--project', 'p', '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.nightId).toMatch(/^n\d{8}T\d{6}$/); expect(out.items[0].title).toBe('Run npm test');
    expect(readdirSync(join(aether(home), 'afk', 'nights'))).toEqual([out.nightId]);
  });
});

describe('main() with a TTY (in process)', () => {
  const deps = (home: string) => ({ homeDir: home, nowMs: new Date(2026, 10, 4, 23).getTime(), isTty: true, readLine: async () => '', print: () => {}, env: {} });
  it('terms set writes through the store', async () => {
    const home = tmpHome();
    expect(await main(['terms', 'set', 'codexReviewsPerPush', '2'], deps(home))).toBe(0);
    expect(readLiveTerms(aether(home)).terms.codexReviewsPerPush).toBe(2);
  });
  it.each([['delete', 'true'], ['forcePush', 'true'], ['notifications', 'toast']])('terms set %s %s is refused (exit 4)', async (k, v) => {
    const home = tmpHome();
    expect(await main(['terms', 'set', k, v], deps(home))).toBe(4);
    expect(existsSync(termsPath(aether(home)))).toBe(false);
  });
  it('TTY_VERBS is exactly the write set, and every verb is declared', () => {
    expect([...TTY_VERBS].sort()).toEqual(['amend', 'approve', 'confirm', 'terms set']);
    for (const v of ['terms show', 'compile', 'feasibility', 'plan', 'deny-rules', 'install-skill', ...TTY_VERBS]) expect(VERBS).toContain(v);
  });
});
```

- [ ] **Step 2:** `npx vitest run scripts/afk/cli.test.ts` -> FAIL.
- [ ] **Step 3: Implement `cli.mjs` and `afk.mjs`.** Dispatch table keyed by verb; a verb in `TTY_VERBS` checks `deps.isTty` BEFORE reading anything or creating any directory.
- [ ] **Step 4:** -> PASS.
- [ ] **Step 5: Commit**

```bash
P="scripts/afk/cli.mjs scripts/afk/afk.mjs scripts/afk/cli.test.ts"
git add -- $P && git commit -m "feat(afk): afk CLI with TTY-gated write verbs" -- $P
```

---

### Task 18: Directory boundary guard

**Files:**
- Create: `scripts/afk/afkBoundary.test.ts`

```owned T18
scripts/afk/afkBoundary.test.ts
```

**Interfaces:** a test only, in the style of `electron/aetherChoice/aetherChoiceBoundary.test.ts` and `electron/voice/voiceBoundary.test.ts`: it pins design rules mechanically so a later edit cannot quietly break them. Source files are the non-test `.mjs` in `scripts/afk/`, comments stripped (a simple `//` and `/* */` strip is enough; strings still count).

- [ ] **Step 1: Write the failing test.** It passes immediately if T1-T17 obeyed the constraints; "fails first" is demonstrated by the red-proof below, not by a missing module.

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const src = Object.fromEntries(files.map((f) => [f, strip(readFileSync(join(dir, f), 'utf8'))]));
const WRITERS = ['fsJson.mjs', 'installSkill.mjs'];

describe('scripts/afk boundary', () => {
  it('is non-empty', () => { expect(files.length).toBeGreaterThan(10); });
  it('no child_process, no claude launch, no model id', () => {
    for (const [f, s] of Object.entries(src)) {
      expect(s, f).not.toMatch(/child_process|execFile|spawn\(|exec\(/);
      expect(s, f).not.toMatch(/claude-[a-z]+-\d/);
    }
  });
  it('bypassPermissions and dangerous flags appear nowhere', () => {
    for (const [f, s] of Object.entries(src)) expect(s, f).not.toMatch(/bypassPermissions|dangerously-skip|--dangerously/i);
  });
  it('filesystem writes happen only in the reviewed writer modules', () => {
    for (const [f, s] of Object.entries(src)) {
      if (WRITERS.includes(f)) continue;
      expect(s, f).not.toMatch(/writeFileSync|renameSync|copyFileSync|appendFileSync|createWriteStream|mkdirSync|unlinkSync|rmSync|writeFile\(/);
    }
  });
  it('nothing deletes: no unlink/rm/rmdir anywhere in non-test source', () => {
    for (const [f, s] of Object.entries(src)) expect(s, f).not.toMatch(/\bunlink|\brmSync|\brmdir|\bfs\.rm\b/);
  });
  it('no network listener or fetch', () => {
    for (const [f, s] of Object.entries(src)) expect(s, f).not.toMatch(/\.listen\(|createServer|\bfetch\(|node:http|node:net/);
  });
});
```

Note: `fsJson.mjs` must remove its own temp file after a failed atomic write, which needs `rmSync`. Allow that one exception: change the "nothing deletes" test to skip `fsJson.mjs` through a `DELETE_ALLOWED = ['fsJson.mjs']` list, with a comment that the module may remove only its own `*.afktmp-*` file. Likewise `fsJson.mjs` is in `WRITERS` for the write test. If any other module needs to delete or write, stop and report instead of widening either list.

- [ ] **Step 2: Red-proof.** Temporarily add `import 'node:child_process';` to `cli.mjs`; run `npx vitest run scripts/afk/afkBoundary.test.ts` and see "no child_process" fail; revert.
- [ ] **Step 3:** `npx vitest run scripts/afk` -> PASS for the whole directory (T1-T18). Also run `npx vitest run src/shared/noApiCalls.test.ts electron/remote/noWildcardListener.test.ts` -> PASS.
- [ ] **Step 4: Commit**

```bash
P="scripts/afk/afkBoundary.test.ts"
git add -- $P && git commit -m "test(afk): directory boundary guard" -- $P
```

---

### Task 19: The pre-flight skill and its installer

**Files:**
- Create: `skills/afk-preflight/SKILL.md`, `scripts/afk/installSkill.mjs`
- Modify: `scripts/afk/cli.mjs` (wire `install-skill`, replacing the T17 stub)
- Test: `scripts/afk/installSkill.test.ts`

```owned T19
skills/afk-preflight/SKILL.md
scripts/afk/installSkill.mjs
scripts/afk/installSkill.test.ts
scripts/afk/cli.mjs
```

**Interfaces:**
- `installSkill.mjs` exports `renderSkill(template, cliPath): string` (replaces every `{{AFK_CLI}}` token; throws if the token is absent or `cliPath` contains a quote, newline or backtick) and `installSkill({homeDir, templatePath, cliPath}): string` (writes `<homeDir>/.claude/skills/afk-preflight/SKILL.md`, returns the path). `install-skill` is run by Matt; it is the only code that writes under `~/.claude`.
- `SKILL.md` frontmatter: `name: afk-preflight`; `description` lists Matt's confirmed phrases ("going to bed", "heading to bed", "off to bed", "going afk"; part 8 of the GUI design also lists "going to work", "stepping away", "heading out", "brb", "be right back": only the overnight ones belong here) and says it prepares an overnight run. Body, in this order, each as a short numbered step: (1) run `node "{{AFK_CLI}}" terms show` and show the terms; (2) ask which projects tonight covers (default: this repo's folder name; the handoff folder name, not a worktree name); (3) run `compile --project …`, show ready / question / barred; (4) ask the clarifying questions for `question` items, at most 3 rounds of at most 4 questions, then stop and say "no open doubts" or list what stays held; (5) run `feasibility`; (6) state back what will run, what is set aside, and which terms apply; (7) tell Matt to type `node "{{AFK_CLI}}" confirm --all-ready` (or specific ids), optionally `amend`, then `approve`, **himself in a shell with a TTY** and to say "done" afterwards; (8) after "done" run `plan` and report what it returned. Rules block: never run `terms set`, `amend`, `confirm` or `approve` (they refuse without a TTY and trying is a violation); never edit anything under `~/.aether-os/afk`; never guess past an ambiguity; deletion, force-push and cleanup are never on the night; an unfinished pre-flight still runs the confirmed items on the last-approved terms and everything else is held.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERBS } from './cli.mjs';
import { installSkill, renderSkill } from './installSkill.mjs';

const templatePath = fileURLToPath(new URL('../../skills/afk-preflight/SKILL.md', import.meta.url));
const template = readFileSync(templatePath, 'utf8');

describe('renderSkill', () => {
  it('replaces every token', () => {
    const out = renderSkill('a {{AFK_CLI}} b {{AFK_CLI}}', 'C:/x/afk.mjs');
    expect(out).toBe('a C:/x/afk.mjs b C:/x/afk.mjs');
  });
  it.each(['C:/x"y', 'a\nb', 'a`b'])('rejects a path containing %j', (p) => { expect(() => renderSkill('{{AFK_CLI}}', p)).toThrow(); });
  it('throws when the template has no token', () => { expect(() => renderSkill('nothing', 'C:/x')).toThrow(); });
});

describe('installSkill', () => {
  it('writes under the given home only', () => {
    const home = mkdtempSync(join(tmpdir(), 'afk-skill-'));
    const dest = installSkill({ homeDir: home, templatePath, cliPath: 'C:/r/scripts/afk/afk.mjs' });
    expect(dest).toBe(join(home, '.claude', 'skills', 'afk-preflight', 'SKILL.md'));
    expect(readFileSync(dest, 'utf8')).toContain('C:/r/scripts/afk/afk.mjs');
    expect(readFileSync(dest, 'utf8')).not.toContain('{{AFK_CLI}}');
  });
});

describe('SKILL.md template', () => {
  it('has the frontmatter name and the overnight phrases', () => {
    expect(template).toMatch(/^---\nname: afk-preflight\n/);
    for (const p of ['going to bed', 'heading to bed', 'off to bed', 'going afk']) expect(template).toContain(p);
  });
  it('every `afk.mjs <verb>` it tells the agent to run is a real verb', () => {
    const verbs = [...template.matchAll(/\{\{AFK_CLI\}\}"\s+([a-z-]+(?: set| show)?)/g)].map((m) => m[1]);
    expect(verbs.length).toBeGreaterThan(3);
    for (const v of verbs) expect(VERBS, v).toContain(v);
  });
  it('forbids the agent from the TTY verbs and from editing the afk dir', () => {
    expect(template).toMatch(/never run[^.]*terms set[^.]*amend[^.]*confirm[^.]*approve/i);
    expect(template).toContain('~/.aether-os/afk');
  });
  it('never mentions bypassPermissions', () => { expect(template).not.toMatch(/bypassPermissions/i); });
});
```

- [ ] **Step 2:** `npx vitest run scripts/afk/installSkill.test.ts` -> FAIL.
- [ ] **Step 3: Implement** `installSkill.mjs`, write `skills/afk-preflight/SKILL.md` to the outline above (plain prose, ASCII punctuation, no emojis), and wire `install-skill` in `cli.mjs` (`cliPath` = the absolute path of `afk.mjs` itself via `import.meta.url`, forward slashes). Add `installSkill.mjs` to `WRITERS` in T18's guard (already listed). Update the T17 test if the stub's exit-4 case was asserted.
- [ ] **Step 4:** `npx vitest run scripts/afk` -> PASS (whole directory).
- [ ] **Step 5: Commit**

```bash
P="skills/afk-preflight/SKILL.md scripts/afk/installSkill.mjs scripts/afk/installSkill.test.ts scripts/afk/cli.mjs"
git add -- $P && git commit -m "feat(afk): afk-preflight skill and install-skill verb" -- $P
```

---

### Task 20: Documentation

**Files:**
- Modify: `docs/privacy-and-data.md` (add `## 19. AFK standing terms and night state`), `CLAUDE.md` (one line in the architecture map for `scripts/afk/` and `skills/afk-preflight/`), `PROGRESS.md` (a "Shipped plans" entry, written when the branch merges, in the style of the entries at `PROGRESS.md:60-70`)

```owned T20
docs/privacy-and-data.md
CLAUDE.md
PROGRESS.md
```

No new test. Content requirements for §19: what is persisted and where (`~/.aether-os/afk/`: terms, night list with titles of at most 140 characters, snapshot, approval, last-approved pointer; no handoff bodies, no absolute paths, no secrets); that the feasibility probe reads key names and a keystore path's existence but never prints or stores a value; that the CLI makes no network call and no model call; that the write verbs need a TTY and why that is a drift guard and not a sandbox; the deny rules Matt installs (list them); the install-skill write to `~/.claude/skills`; and that retention is "until Matt deletes the night directory" (nothing in Phase 1 purges; the agent cannot, by design).

- [ ] **Step 1:** Add the three edits.
- [ ] **Step 2: Verify**

Run: `npx vitest run src/shared/noApiCalls.test.ts scripts/afk`
Run: `grep -n "^## 19\." docs/privacy-and-data.md`
Expected: tests PASS; grep prints one line.

- [ ] **Step 3: Commit**

```bash
P="docs/privacy-and-data.md CLAUDE.md PROGRESS.md"
git add -- $P && git commit -m "docs(afk): privacy section 19, architecture map and progress entry for Phase 1" -- $P
```

---

### Task 21: Live verification (no code, no commit)

**Files:** none. Output: a result note at `~/.claude/handoffs/aether-os/2026-11-04-afk-phase1-live-check.md` (outside the repo). This task needs Matt at the keyboard; the builder prepares the checklist and reports it, then stops.

```owned T21
```

- [ ] **M1: TTY reality.** In an Aether terminal with `claude` running, type `! node scripts/afk/afk.mjs terms set opusEscalation false` and record the exit. Then in a plain PowerShell window run the same. Expected: plain window exit 0 (or 4 if refused for no change); record what `!` does. Outcome decides where Matt runs `confirm`/`approve`. If `!` has a TTY it is a Matt-only channel; if not, he uses a plain window.
- [ ] **M2: Deny rules.** `node scripts/afk/afk.mjs deny-rules` prints the list. Matt pastes the rules into the `permissions.deny` array of `~/.claude/settings.json` himself. Then, in a fresh claude session, ask the agent to append a line to `~/.aether-os/afk/terms.json`. Expected: denied. Also confirm a deny rule beats the existing global `allow` entries by trying `git branch -D` on a throwaway branch of a throwaway repo. Record both; UNVERIFIED until run.
- [ ] **M3: Skill.** `node scripts/afk/afk.mjs install-skill`, start a new claude session, run `/afk-preflight` (fall back to the phrase "I'm going to bed" if the slash form is not offered; if neither works, move the skill to `~/.claude/commands/afk-preflight.md` and note it). Walk a full pre-flight on a THROWAWAY project with one ready item, one question item and one barred item. Expected end state: `afk plan` prints `kind: approved` with exactly the one confirmed item, and `held` lists the other two with reasons.
- [ ] **M4: Unfinished path.** Compile again without approving, confirm one item, run `afk plan`. Expected: `kind: unfinished`, terms equal to the last-approved snapshot.

Report PASS/FAIL per check with the real output lines. Nothing here is committed.

---

## Open items for Matt (flagged, not decided)

1. **Force-push counts as delete** (design 13): kept barred in `terms.mjs` and `buildDenyRules`. Prefix rules cannot catch `+refspec` or `:branch` pushes, so the Safety Net hook is the real second layer.
2. **`git rm` of a tracked file inside a spec'd change**: Phase 1 lists it as barred (the prototype did), so a refactor that deletes a file goes yellow. Say if tracked-file deletion in a commit should be allowed.
3. **Fable requires Opus** (`fableElevation` rejected unless `opusEscalation`): Claude's call to keep the ladder coherent; design 5 only says Fable follows three failed Opus reviews.
4. **Reviews per push capped at 3** in the validator (Matt approved up to 3).
5. **Debug vs release APK** is "the expected APK": recipe uses `assembleDebug` (what Matt installs on the S25 per memory); `verifyAetherSigning` makes both need the signing keys.
6. **The recipe for `npm run dist -- -c.directories.output=…`** has not been run; first real use is the throwaway-repo test with Matt present (design 11).

## Risks recorded

- Until Matt installs the deny rules (T21 M2), an interactive agent could write `~/.aether-os/afk/` directly; the TTY gate protects only the verbs. The approval summary re-prints the confirmed items to Matt, so a tampered approved night is visible to him; a tampered unfinished-night draft is not.
- The `/afk-preflight` auto-trigger is model-judged. It is not the rules-first detector with a tense guard (Phase 4).
- The compiler's stale-handoff problem (D3) and the classifier's heuristics produce false `question`/`barred`, never silent `ready` for a marked item; a false `ready` is caught only by Matt's confirmation.
- Scripts tests run under two vitest configs; a test that needs a root-only dependency would pass in one and fail in the other.
