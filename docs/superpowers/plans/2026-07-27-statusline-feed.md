# Statusline Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the app's *estimated* depletion ETA and its *fictional* CONTEXT tile with
Claude Code's own authoritative data. Claude Code passes a JSON payload on **stdin** to any
configured `statusLine` script, carrying server-side 5-hour and 7-day rate-limit percentages with
exact reset timestamps, plus live context-window occupancy with a four-way token split. This plan
ships a statusline script, a one-click installer, a file-watch feed into the Electron main process,
and the state/UI wiring to consume it — with the existing estimate preserved as a fallback when the
statusline is not installed.

**Architecture:** A tiny standalone Node script (`scripts/aether-statusline.mjs`) that Claude Code
executes; it writes the payload atomically to `~/.aether-os/statusline.json` and prints a status
line to stdout so it still works as a statusline. Electron watches that file and pushes parsed
snapshots to the renderer on the existing `sendToWindow` pattern. Pure parse/validate and pure
depletion math land in `src/shared/`. Settings gains an install/status card following the
`optimize:apply`-style explicit-user-action IPC pattern. State/reducer/hook wiring follows this
app's established conventions exactly (`SET_REAL_USAGE`-style reducer cases, `useRealUsageSync`-style
sync hooks, `attachments`-style invoke IPC).

**Tech Stack:** TypeScript (strict), React 18, Electron main-process IPC + fs, Node ESM script, Vitest.

## Global Constraints

- No CSS modules or styled-components — inline styles only, per this codebase's established convention.
- `npm test`, `npm run build`, and `npm run electron:build` clean before every commit that touches `electron/`.
- **Graceful degradation is a hard requirement.** With no statusline installed, the app must behave
  exactly as it does today: the estimated depletion ETA and the existing fictional CONTEXT tile
  remain. Nothing may crash, blank, or show a permanent error state on a clean clone. A reviewer
  running `npm run electron:dev` with no setup must see a working app.
- **`~/.claude/settings.json` is a user-owned file.** The installer merges one key and preserves
  everything else byte-for-byte where possible; it never rewrites or reformats the file wholesale,
  and it always writes a timestamped backup first. Mirror `optimizeActions.ts`'s byte-preservation
  discipline and `electron/main.ts`'s `optimize:apply` backup pattern.
- The main process is the ONLY place a file path is decided. The renderer triggers install/uninstall
  by name and never sends or receives a raw writable path it could tamper with.
- Do not touch `src/components/grid/` or `src/components/reactor/`. Reactor consumption of the real
  rate-limit denominator is Stage 7 (`docs/roadmap.md`), explicitly out of scope here.
- Do not modify `electron/liveAgentTracker.ts` or the 60s `scanAndPushUsage()` cycle. This plan is
  purely additive; retiring the pollers is Stage 3.

## Payload semantics — read before writing any code

These are documented, version-sensitive, and easy to get subtly wrong. Every one of them needs a test.

- `rate_limits.five_hour.used_percentage` and `.seven_day.used_percentage` are **0–100 numbers**,
  not 0–1 fractions.
- `rate_limits.*.resets_at` is **unix epoch SECONDS**, not milliseconds. Multiply by 1000 before
  constructing a `Date`.
- `context_window.used_percentage` is **input-only**: it counts `input_tokens +
  cache_creation_input_tokens + cache_read_input_tokens` and **excludes `output_tokens`**. A
  hand-rolled percentage that includes output will not match Claude Code's own bar.
- `context_window.current_usage` is **`null`** before the first API call of a session, and **`null`
  again immediately after `/compact`**. Every consumer must handle null, not just absent.
- Updates are **event-driven with a 300ms debounce** (new assistant message, `/compact` finish,
  permission-mode change), *not* on a timer. The file can be stale for minutes during a long tool
  call and that is normal, not an error — but a payload older than a threshold should be treated
  as stale for UI purposes (see Task 3).
- The payload also carries `session_id`, `model.{id,display_name}`, `cost.total_cost_usd`,
  `workspace.{current_dir,project_dir}` and `pr.{number,url,review_state}`. Parse and store them;
  this plan only *consumes* rate limits and context window, but Stages 4–6 will want the rest and
  re-parsing later is wasted work.

---

### Task 1: `src/shared/statuslinePayload.ts` — types + pure parse/validate

**Files:**
- Create: `src/shared/statuslinePayload.ts` + `statuslinePayload.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RateLimitWindow {
    usedPercentage: number;   // 0-100
    resetsAtMs: number;       // epoch MILLISECONDS (converted from the payload's seconds)
  }
  export interface ContextWindowUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  }
  export interface StatuslineSnapshot {
    capturedAtMs: number;
    sessionId: string | null;
    modelId: string | null;
    modelDisplayName: string | null;
    fiveHour: RateLimitWindow | null;
    sevenDay: RateLimitWindow | null;
    contextUsedPercentage: number | null;      // input-only, per the payload's own definition
    contextWindowSize: number | null;
    contextUsage: ContextWindowUsage | null;   // null before first API call and right after /compact
    totalCostUsd: number | null;
    currentDir: string | null;
    projectDir: string | null;
  }
  export function parseStatuslinePayload(raw: unknown, capturedAtMs: number): StatuslineSnapshot | null;
  ```

**Steps:**
- [ ] Write `parseStatuslinePayload` as a **defensive** parser: it receives whatever `JSON.parse`
      produced and must never throw. Return `null` only when `raw` is not a non-null object.
      Every individual field is independently optional — a payload missing `rate_limits` entirely
      still yields a valid snapshot with `fiveHour: null, sevenDay: null`. Claude Code's payload
      shape has changed across versions and will change again; a parser that hard-fails on one
      unexpected field takes the whole feature down.
- [ ] Convert `resets_at` from **seconds to milliseconds** (`* 1000`). Guard: only produce a
      `RateLimitWindow` when BOTH `used_percentage` is a finite number AND `resets_at` is a finite
      number; a window with one but not the other is `null`, not a half-populated object.
- [ ] Map `context_window.used_percentage` → `contextUsedPercentage`,
      `context_window.context_window_size` → `contextWindowSize`, and
      `context_window.current_usage` → `contextUsage` (mapping the four snake_case token fields to
      the camelCase names above). `current_usage: null` must produce `contextUsage: null` — do not
      substitute a zeroed object, because "no data" and "zero tokens" are different states and the
      UI needs to distinguish them.
- [ ] Map `session_id`, `model.id`, `model.display_name`, `cost.total_cost_usd`,
      `workspace.current_dir`, `workspace.project_dir`, each independently null-guarded.
- [ ] Tests — cover, at minimum: a full realistic payload parsing correctly; seconds→ms conversion
      asserted with a concrete expected value; `current_usage: null` producing `contextUsage: null`;
      a payload with no `rate_limits` key producing both windows `null`; a window with
      `used_percentage` but no `resets_at` producing `null` for that window; `raw` being `null`,
      a string, and a number each returning `null`; and an unknown extra top-level field being
      ignored without error.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean.
- [ ] Commit: `feat: add statusline payload types and defensive parser`

---

### Task 2: `src/shared/depletion.ts` — pure depletion + freshness math

**Files:**
- Create: `src/shared/depletion.ts` + `depletion.test.ts`

**Interfaces:**
- Consumes: `StatuslineSnapshot`, `RateLimitWindow` (Task 1).
- Produces:
  ```ts
  export type DepletionSource = 'statusline' | 'estimate' | 'none';
  export interface DepletionReadout {
    source: DepletionSource;
    usedPercentage: number | null;   // 0-100
    resetsAtMs: number | null;
    msUntilReset: number | null;
    /** Projected ms until the window is exhausted at the current consumption pace, or null
     *  when it will not deplete before the window resets. */
    msUntilDepleted: number | null;
    /** True when the projection says the limit runs out before the window resets. */
    depletesBeforeReset: boolean;
    stale: boolean;
  }
  export const STATUSLINE_STALE_AFTER_MS: number; // 10 * 60 * 1000
  export function deriveDepletion(
    snapshot: StatuslineSnapshot | null,
    windowStartMs: number | null,
    nowMs: number,
  ): DepletionReadout;
  export function formatResetCountdown(msUntilReset: number | null): string;
  ```

**Steps:**
- [ ] `deriveDepletion` with `snapshot === null` or `snapshot.fiveHour === null` returns
      `{ source: 'none', ... }` with all numeric fields `null` and `depletesBeforeReset: false`.
      The caller (Task 6) is responsible for falling back to the existing estimate on `'none'`;
      this function does not know the estimate exists.
- [ ] Freshness: `stale = (nowMs - snapshot.capturedAtMs) > STATUSLINE_STALE_AFTER_MS`. Set
      `STATUSLINE_STALE_AFTER_MS = 10 * 60 * 1000`. Rationale to put in a code comment: statusline
      updates are event-driven with a 300ms debounce, not timer-driven, so a payload can legitimately
      be several minutes old during one long tool call. Ten minutes is comfortably past that without
      being so long that a genuinely dead feed reads as live. **A stale snapshot still returns its
      numbers** — it sets the flag and lets the UI decide, rather than blanking the readout.
- [ ] Projection: consumption pace is derived from `usedPercentage` over the elapsed portion of the
      window. Given `windowStartMs` (the reset time minus the 5-hour window length — compute it,
      do not require the caller to know it), `elapsedMs = nowMs - windowStartMs`. If
      `elapsedMs <= 0` or `usedPercentage <= 0`, `msUntilDepleted = null` and
      `depletesBeforeReset = false`. Otherwise `pacePerMs = usedPercentage / elapsedMs`,
      `msUntilDepleted = (100 - usedPercentage) / pacePerMs`. Set
      `depletesBeforeReset = msUntilDepleted < msUntilReset`. When `usedPercentage >= 100`, return
      `msUntilDepleted = 0` and `depletesBeforeReset = true`.
- [ ] `formatResetCountdown`: `null` → `'—'`; negative or zero → `'now'`; under an hour → `'42m'`;
      otherwise → `'3h 12m'`. Match the existing `fmtElapsed` formatting conventions in
      `src/utils/format.ts` — **read that file first** and reuse its helpers if the shape fits
      rather than duplicating logic.
- [ ] Tests — this is the highest-risk math in the plan; cover thoroughly: null snapshot → `'none'`;
      snapshot with `fiveHour: null` → `'none'`; a fresh snapshot at 50% with 2h elapsed of a 5h
      window projecting depletion at the 4h mark (hand-compute the expected value); a snapshot at
      10% with 4h elapsed NOT depleting before reset (`depletesBeforeReset: false`,
      `msUntilDepleted` greater than `msUntilReset`); `usedPercentage: 0` → `msUntilDepleted: null`;
      `usedPercentage: 100` → `msUntilDepleted: 0, depletesBeforeReset: true`; `elapsedMs <= 0`
      (a clock-skew case) → `msUntilDepleted: null` rather than a division blowup; stale flag true
      and false either side of the threshold, asserting the numbers are still returned when stale;
      and each `formatResetCountdown` branch.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean.
- [ ] Commit: `feat: add pure depletion projection and staleness math`

---

### Task 3: `scripts/aether-statusline.mjs` — the statusline script itself

**Files:**
- Create: `scripts/aether-statusline.mjs`

**Interfaces:**
- Produces: writes `~/.aether-os/statusline.json`; prints one line to stdout.

**Steps:**
- [ ] Read all of stdin (Claude Code passes the payload there), `JSON.parse` it inside a
      `try/catch`. **On any failure, print a minimal fallback line and exit 0.** This script runs
      inside the user's live Claude Code session — a throw here degrades their statusline on every
      turn. It must never exit non-zero and never write to stderr.
- [ ] Write the raw parsed object plus a `capturedAtMs: Date.now()` field to
      `~/.aether-os/statusline.json` **atomically**: write to `statusline.json.tmp` in the same
      directory, then `fs.renameSync` over the target. A non-atomic write races the Electron
      watcher and will intermittently hand it a truncated file. `mkdirSync(dir, { recursive: true })`
      first.
- [ ] Print a genuinely useful status line to stdout so the script earns its place even when Aether
      OS is closed — model display name, 5h used %, and context used %, e.g.
      `Opus 4.6 · 5h 47% · ctx 62%`. Keep it under ~60 chars and use no ANSI colour (the terminal
      config owns colour, and a hardcoded escape sequence will fight the user's theme).
- [ ] Use only Node builtins (`node:fs`, `node:path`, `node:os`, `node:process`). **No imports from
      `src/` or `electron/`, and no npm dependencies** — this file is executed by Claude Code from
      an arbitrary working directory with no relationship to this repo's module resolution, so any
      relative import will fail at runtime in a way tests will not catch.
- [ ] Verify manually: `echo '{"model":{"display_name":"Opus 4.6"},"rate_limits":{"five_hour":{"used_percentage":47,"resets_at":1785200000}},"context_window":{"used_percentage":62}}' | node scripts/aether-statusline.mjs` prints the expected line and produces a well-formed `~/.aether-os/statusline.json`. Also verify the empty-stdin and malformed-JSON cases exit 0.
- [ ] Commit: `feat: add aether-statusline script (atomic payload capture + status line output)`

---

### Task 4: `electron/statuslineInstaller.ts` — safe settings.json merge

**Files:**
- Create: `electron/statuslineInstaller.ts` + `statuslineInstaller.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type InstallStatus = 'installed' | 'installed-other' | 'not-installed' | 'unreadable';
  export interface StatuslineInstallState {
    status: InstallStatus;
    /** The currently configured statusLine command, if any — shown to the user before we overwrite it. */
    existingCommand: string | null;
    settingsPath: string;
    scriptPath: string;
  }
  export function statuslineSettingsPatch(scriptPath: string): { statusLine: { type: 'command'; command: string } };
  export function detectInstallStatus(settingsJson: unknown, scriptPath: string): { status: InstallStatus; existingCommand: string | null };
  export async function readInstallState(settingsPath: string, scriptPath: string): Promise<StatuslineInstallState>;
  export async function installStatusline(settingsPath: string, scriptPath: string): Promise<{ ok: boolean; backupPath?: string | null; error?: string }>;
  export async function uninstallStatusline(settingsPath: string): Promise<{ ok: boolean; backupPath?: string | null; error?: string }>;
  ```

**Steps:**
- [ ] `detectInstallStatus` is pure and gets its own tests: `'installed'` when the configured
      command references `scriptPath`; `'installed-other'` when a `statusLine` key exists but points
      somewhere else (**this case must be surfaced, not silently overwritten** — the user may have
      claude-powerline or CCometixLine configured and clobbering it without asking is exactly the
      kind of thing that makes people uninstall a tool); `'not-installed'` when the key is absent;
      `'unreadable'` when the parsed settings are not a non-null object.
- [ ] `installStatusline`: read the existing file (`ENOENT` → treat as `{}`, and record that the
      file did not exist), `JSON.parse` inside a try/catch (**parse failure must abort with an error,
      never proceed** — overwriting a settings file we could not read is destructive), write a
      timestamped backup `${settingsPath}.aetherbak-${Date.now()}` when the file existed, then write
      back `JSON.stringify({ ...existing, ...patch }, null, 2)`.
- [ ] Document in a code comment the one deliberate deviation from `optimizeActions.ts`'s
      byte-preservation rule: `settings.json` is JSON, not Markdown, so a structural merge and
      re-serialize is the only correct approach — a text-level insert cannot safely handle nested
      objects, trailing commas, or key ordering. **The backup is what makes this acceptable**, and
      the comment should say so.
- [ ] `uninstallStatusline`: same read/backup discipline, `delete existing.statusLine`, write back.
      Deleting a key that is not present is a successful no-op, not an error.
- [ ] Tests using the temp-directory fixture pattern — **read `electron/windowBounds.test.ts` first**
      for this codebase's established temp-file convention rather than inventing one. Cover: install
      into a missing file; install into an existing file preserving unrelated keys (assert a
      sentinel key survives verbatim); install when `statusLine` already points elsewhere; a backup
      file being created with the original content; malformed JSON aborting with `ok: false` and
      **leaving the original file untouched** (assert the bytes are unchanged); uninstall removing
      only the one key; uninstall on a file with no `statusLine` succeeding.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean.
- [ ] Commit: `feat: add statusline installer with safe settings.json merge and backup`

---

### Task 5: `electron/statuslineWatcher.ts` + main-process wiring

**Files:**
- Create: `electron/statuslineWatcher.ts`
- Modify: `electron/main.ts`

**Interfaces:**
- Consumes: `parseStatuslinePayload` (Task 1), `readInstallState`/`installStatusline`/`uninstallStatusline` (Task 4).
- Produces: `sendToWindow('statusline:snapshot', snapshot)`; `ipcMain.handle('statusline:state', ...)`, `ipcMain.handle('statusline:install', ...)`, `ipcMain.handle('statusline:uninstall', ...)`.
  ```ts
  export function startStatuslineWatcher(payloadPath: string, onSnapshot: (s: StatuslineSnapshot) => void): () => void;
  ```

**Steps:**
- [ ] `startStatuslineWatcher`: read the file once on start (so a snapshot written before the app
      launched is picked up immediately), then watch it. Use `fs.watchFile` with a ~2s interval
      rather than `fs.watch` — `fs.watch` on Windows is unreliable for atomic-rename replacement,
      which is exactly the write pattern Task 3 uses. Returns an unsubscribe function that calls
      `fs.unwatchFile`; **call it on app quit**, matching how the existing watchers/intervals in
      `main.ts` are torn down (read that file's cleanup path first).
- [ ] Every read is `try/catch`ed and routed through `parseStatuslinePayload`. A missing file, a
      partial read, or a parse failure is a silent no-op — not an error push. The renderer's state
      simply keeps the last good snapshot, which is the correct behaviour for an event-driven feed.
- [ ] Read `capturedAtMs` from the payload if the script wrote it; otherwise fall back to the file's
      `mtimeMs`. Never use `Date.now()` at read time — that would make every snapshot look fresh and
      defeat Task 2's staleness detection entirely.
- [ ] In `main.ts`: start the watcher on `~/.aether-os/statusline.json` where the other startup
      wiring lives, and push each snapshot with `sendToWindow('statusline:snapshot', snapshot)`.
- [ ] Add the three `ipcMain.handle` calls near the existing `optimize:*` handlers for locality.
      `statusline:install` and `statusline:uninstall` are explicit user actions only — **never call
      them from any automatic path.** Resolve `scriptPath` in main via `app.getAppPath()` (or the
      packaged-resources equivalent — check how any existing script path is resolved in this file
      first) and never accept a path from the renderer.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean, `npm run electron:build` clean.
- [ ] Commit: `feat: watch the statusline payload file and expose install/uninstall IPC`

---

### Task 6: preload + state + sync hook

**Files:**
- Modify: `electron/preload.ts`, `src/aetherElectron.d.ts`, `src/state/types.ts`, `src/state/initialState.ts`, `src/state/reducer.ts` (+ `reducer.test.ts`), `src/App.tsx`
- Create: `src/state/useStatuslineSync.ts`

**Interfaces:**
- Produces: `state.statusline: StatuslineSnapshot | null`, action `SET_STATUSLINE`, `window.aetherElectron.statusline.{onSnapshot,state,install,uninstall}`.

**Steps:**
- [ ] `electron/preload.ts`: add a `statusline` namespace — `onSnapshot` following `onActiveWork`'s
      push-listener pattern (returning an unsubscribe that calls `removeListener`), and
      `state`/`install`/`uninstall` following `attachments.list`'s invoke pattern.
- [ ] `src/aetherElectron.d.ts`: matching declarations, following the style `optimize`/`attachments`
      already use — read the file first.
- [ ] `src/state/types.ts`: add `statusline: StatuslineSnapshot | null` to `AetherState`.
      `src/state/initialState.ts`: `statusline: null`. **Do not add it to `persistence.ts`'s
      whitelist** — a rehydrated stale snapshot would show a fresh-looking rate-limit percentage
      from a previous session, which is precisely the class of dishonesty the `logs` exclusion
      exists to prevent. Add a code comment saying so.
- [ ] `src/state/reducer.ts`: add `SET_STATUSLINE` to the `Action` union and a case handler
      mirroring `SET_REAL_USAGE`'s wholesale-replace shape — read it first. Add a reducer test
      matching the file's existing per-action style.
- [ ] Create `src/state/useStatuslineSync.ts` as a single `useEffect` matching
      `useRealUsageSync.ts`'s shape exactly, and mount it in `src/App.tsx` as a bare
      `StatuslineSync` wrapper component alongside `RealUsageSync`/`RealAgentsSync`/`AlertSounds`.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean, `npm run electron:build` clean.
- [ ] Commit: `feat: plumb statusline snapshots into renderer state`

---

### Task 7: Consume it — DEPLETION ETA, CONTEXT tile, Settings card

**Files:**
- Modify: `src/components/dashboard/ReactorStatusCard.tsx`, `src/components/layout/BottomMetricsRow.tsx`
- Create: `src/components/settings/StatuslineCard.tsx`
- Modify: `src/components/settings/SettingsView.tsx`

**Interfaces:**
- Consumes: `state.statusline`, `deriveDepletion`/`formatResetCountdown` (Task 2), `window.aetherElectron.statusline.*` (Task 6), `useColors`, `Button`.

**Steps:**
- [ ] **Read `ReactorStatusCard.tsx` in full first** and locate the existing DEPLETION ETA and
      CONTEXT tiles and how they currently compute their values.
- [ ] DEPLETION ETA: call `deriveDepletion(state.statusline, null, Date.now())`. On
      `source: 'statusline'`, show the real projection plus the reset countdown, e.g.
      `2h 14m · resets 3h 01m`. On `source: 'none'`, **render exactly what it renders today** —
      the existing estimate, unchanged. When `stale` is true, render the value with the existing
      `colors.warn` treatment and a `~` prefix rather than hiding it.
- [ ] CONTEXT tile: on a snapshot with a non-null `contextUsedPercentage`, show the real percentage
      and drop the fictional value. **When `contextUsage` is null but `contextUsedPercentage` is
      present, still show the percentage** — that is the normal state immediately after `/compact`
      and it is real data. When there is no snapshot at all, the existing fictional value stays,
      preserving today's behaviour on a clean clone.
- [ ] Add a small, unobtrusive source indicator to both tiles so it is never ambiguous whether a
      number is measured or estimated — a single dim `LIVE` / `EST` chip using the existing
      `chipBorder`/`panelInset` quiet-chip convention. **This is the point of the whole plan:** an
      instrument that does not say whether it is reading or guessing is not an instrument.
- [ ] `BottomMetricsRow.tsx`: read it first, then add the 7-day window as a second bar in the
      existing TOKEN USAGE card **only if the layout accommodates it without reflowing neighbours**
      — the frame is fixed and this plan does not own layout changes. If it does not fit cleanly,
      skip it and note the deferral in the task report rather than compressing an existing card.
- [ ] `StatuslineCard.tsx`: a Settings card showing status from `statusline.state()` — installed /
      not installed / **pointing at another tool** (show `existingCommand` verbatim so the user can
      see what they would lose) / unreadable. An `Install` `Button`; when status is
      `installed-other`, the button reads `Replace` and requires a second confirming click before
      calling through. An `Uninstall` `Button` when installed. A status line reporting the result
      including the backup path on success. Model the confirm-then-act interaction on
      `OptimizeView`'s target-picker overlay pattern rather than inventing a new one.
- [ ] Register the card in `SettingsView.tsx` alongside the existing cards.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean, `npm run electron:build` clean. No new unit-testable logic lands in this task — all of it was tested in Tasks 1, 2 and 4. Visual correctness is deferred to a manual live-window check; **note this explicitly in the task report**, and state which of the four Settings-card states were actually exercised by hand.
- [ ] Commit: `feat: consume real rate-limit and context data in dashboard tiles, add statusline Settings card`

---

After all seven tasks: whole-branch review, then a `PROGRESS.md` entry in the established format,
explicitly noting:

- **(a)** The CONTEXT tile is no longer fictional when a statusline is installed. This **reverses**
  the Phase 2 decision recorded as *"a single session's live context-window fill isn't reliably
  derivable from batch-scanning historical transcripts."* That reasoning was correct about
  transcript scanning and simply did not apply to the statusline stdin feed, which did not exist in
  the app's data model at the time. Record it as a documented reversal with the evidence, in the
  same style as the `usageTokens()` correction — reversals that name what changed are worth more
  than silent fixes.
- **(b)** DEPLETION ETA is now server-authoritative when installed and falls back to the existing
  estimate when not. Both paths remain live; the `EST`/`LIVE` chip is what tells them apart.
- **(c)** The app remains fully functional with no statusline installed, verified by running with
  `~/.aether-os/statusline.json` absent.
- **(d)** `~/.claude/settings.json` is merged structurally rather than byte-preserved, deliberately,
  because it is JSON — with a timestamped backup on every write and an abort-on-unparseable rule.
- **(e)** Reactor consumption of the real rate-limit denominator is Stage 7 and explicitly out of
  scope here; `src/components/reactor/` was not touched.
- **(f)** Which statusline payload fields are parsed and stored but not yet consumed
  (`pr.*`, `workspace.*`, `cost.total_cost_usd`, `model.*`), and which stage consumes each.
