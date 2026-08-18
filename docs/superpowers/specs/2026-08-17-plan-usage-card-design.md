# Plan Usage Card — Design

## Context

Today's session removed `SystemOverviewCard` from `TerminalView`'s right
rail (fake `Math.random()`-driven CPU/MEM/NET/DISK metrics — see the
2026-08-17 fictional-data-removal commit `0046ea3`), leaving that slot
empty. Separately, TokenMonitor (a sibling project) has a "Plan usage"
panel (`src/renderer/dashboard/panels/budgets.js`) that shows the Claude
plan's tier (Pro/Max), Session (5h) and Week (7d) usage percentages, a
per-model week breakdown (Max only), and a reset time — all scraped from
Claude Code's `/usage` TUI by writing `/usage\r` into TokenMonitor's own
embedded pty and screen-scraping the settled frame, since there is no
programmatic API for these percentages.

The user asked for "a version of the token tracker plan usage panel for
usage tracking" to fill the empty rail slot. Investigation this session
found two things that change what a faithful port should actually do:

1. **aether-os already has better data for half of it.** `state.statusline`
   (`src/shared/statuslinePayload.ts`, populated live by a statusline
   watcher — not pty-scraped) already carries `fiveHour`/`sevenDay`
   `{ usedPercentage, resetsAtMs }`. This is strictly richer than what
   TokenMonitor's `/usage` scrape produces for the same two numbers:
   TokenMonitor's session bar has **no reset countdown at all** (its
   parser, `src/shared/usageParser.js`, only captures a percentage for
   "Current session"), and its data only refreshes on a manual click. Real
   epoch-ms reset times are the reason `ReactorStatusCard`'s DEPLETION ETA
   tile already reads `state.statusline` directly — this card should too,
   for Session/Week.
2. **`tier` is inferred, not read.** TokenMonitor's parser sets
   `tier: model ? 'max' : 'pro'` — it decides "Max" purely from whether a
   per-model week-usage line rendered before Escape was sent. This is the
   documented root cause of TokenMonitor's own "Esc-on-first-parse misreads
   Max accounts as Pro" gotcha, and it means tier and the per-model
   breakdown are really *one* signal, not two: the only new information
   `/usage`-scraping earns for aether-os is "did a per-model week line
   appear," which is unavailable anywhere else.

Given both, the scope for aether-os's version is smaller than a straight
port: **Session/Week bars come from the already-live `state.statusline`;
`/usage`-scraping is added only to catch the per-model week line (and
thus infer tier).**

The mechanism for that scrape reuses aether-os's *existing*, always-on
Terminal pty rather than spawning a second one. This was a deliberate
choice against TokenMonitor's own precedent applying cleanly: TokenMonitor
does the identical thing (writes `/usage\r` into its own live embedded
pty, manually triggered via a Sync button) to the *same kind* of always-on
`claude` session aether-os's Terminal tab runs. A second, separate
background pty was considered and rejected — it would mean launching a
second concurrent `claude` session purely to poll it, which runs directly
against the "Aether should not cost a user money" principle already
documented in `src/state/initialState.ts`'s `autoHeadlines` comment
(referencing a real prior billing incident, `docs/roadmap.md` §3.4/3.5).
Reusing the visible pty costs nothing extra to spawn — it just borrows a
few seconds of an already-running session, exactly as TokenMonitor already
does, gated on a manual Sync button so the momentary interruption (a
`/usage` command appearing, then an Escape) only happens when the user
chooses it.

## Goal

Add a `PlanUsageCard` to `TerminalView`'s right rail (replacing
`SystemOverviewCard`'s old slot) showing:

- Session (5h) and Week (7d) usage bars, live from `state.statusline`,
  with real reset countdowns.
- A Pro/Max tier badge and, for Max, a per-model week usage bar — both
  from a new manually-triggered `/usage` scrape of the existing Terminal
  pty.
- A Sync button (disabled when the Terminal pty isn't alive or a sync is
  already in flight) and a "last sync failed" / "as of Xm ago" freshness
  indicator for the scraped fields specifically.

The scraped tier/per-model data persists to disk (survives an app
restart) — unlike most of `AetherState`'s other live/derived fields.

## Non-goals

- **No separate background pty.** See Context — rejected on cost grounds.
- **No re-scraping Session/Week percentages.** `state.statusline` already
  provides them, live and with real reset times; the new scraper only
  looks for the per-model week line.
- **No change to `ReactorStatusCard`'s existing DEPLETION ETA tile** — it
  already reads `state.statusline` independently for its own purpose and
  is untouched by this work.
- **No automatic/periodic sync.** Manual Sync button only, matching
  TokenMonitor's own precedent and keeping the live-pty interruption
  entirely user-initiated.
- **No warning/limit-reached detection** (TokenMonitor's
  `parseLimitWarnings`) — out of scope; `state.statusline`'s existing
  `alarmLevel` derivation (`tick.ts`, already live) covers rate-limit
  alarms for this app.

## Architecture

### `electron/ansiStrip.ts` (new)

aether-os has no existing ANSI-stripping utility (checked: no file
anywhere under `electron/` or `src/shared/`). Direct TS port of
TokenMonitor's `src/shared/ansiStrip.js` (pure, no dependencies, 5 lines
of regex — nothing to adapt beyond the module syntax):

```ts
const CSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
const OTHER_ESC = /\x1b[@-_]/g;
const C0 = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g; // keep \n \t \r

export function stripAnsi(chunk: unknown): string {
  return String(chunk == null ? '' : chunk).replace(CSI, '').replace(OSC, '').replace(OTHER_ESC, '').replace(C0, '');
}
```

### `electron/planUsageScraper.ts` (new)

Pure, stateful module mirroring TokenMonitor's `usageScraper.js` shape,
but narrowed to the one signal aether-os needs — the per-model week line,
from which tier is inferred:

```ts
import { stripAnsi } from './ansiStrip';

const BUFFER_CAP = 16384;
// Matches TokenMonitor's usageParser.js WEEK_MODEL_RE exactly -- same TUI,
// same calibration history (see that file's own comment for why the
// pattern is shaped this way).
const WEEK_MODEL_RE = /Current week \((?!all models)[^)]+\)[\s\S]{0,150}?(\d{1,3})\s*%\s*used/i;

export interface PlanUsageTierSnapshot {
  tier: 'pro' | 'max';
  weekModel: { pct: number } | null;
  capturedAtMs: number;
}

// Liveness-only signal, reusing TokenMonitor's own SESSION_RE calibration
// -- NOT used for its percentage (state.statusline already has that),
// only to prove the /usage pane actually opened at all. Without this,
// "no model line ever appeared" is indistinguishable from "the pane never
// rendered because claude isn't running in this pty," and the sync would
// silently report a confident (and wrong) 'pro' in the second case.
const SESSION_SEEN_RE = /Current session/i;

export function createPlanUsageScraper(now: () => number = Date.now) {
  let buffer = '';
  let snapshot: PlanUsageTierSnapshot | null = null;
  let sawUsagePane = false;

  function ingest(chunk: string): void {
    try {
      buffer = (buffer + stripAnsi(chunk)).slice(-BUFFER_CAP);
      if (SESSION_SEEN_RE.test(buffer)) sawUsagePane = true;
      const model = matchLast(WEEK_MODEL_RE, buffer);
      if (model) {
        const pct = Number(model[1]);
        if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
          snapshot = { tier: 'max', weekModel: { pct }, capturedAtMs: now() };
        }
      }
    } catch {
      /* parsing must never break the pty data path -- same rule as TokenMonitor's scraper */
    }
  }

  function getSnapshot(): PlanUsageTierSnapshot | null {
    return snapshot;
  }

  /** True once any /usage pane text has been seen since the last reset() --
   *  distinguishes "confirmed Pro" from "the pane never opened." */
  function hasSeenUsagePane(): boolean {
    return sawUsagePane;
  }

  function reset(): void {
    buffer = '';
    snapshot = null;
    sawUsagePane = false;
  }

  return { ingest, getSnapshot, hasSeenUsagePane, reset };
}

function matchLast(re: RegExp, text: string): RegExpExecArray | null {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null = null;
  let cur: RegExpExecArray | null;
  while ((cur = g.exec(text)) !== null) m = cur;
  return m;
}
```

Note: unlike TokenMonitor's scraper, `ingest` never *decides* "this is
Pro" on its own — absence of a model line is ambiguous until quiescence
(see below), so `snapshot` starts `null` and only ever gets set to `'max'`
when a model line is actually seen. The `plan:sync` handler (next section)
is what decides `'pro'`, on quiescence with no model line ever having
appeared.

### `electron/main.ts` (modified)

Two additions, no change to `PtyLifecycle` itself:

1. A module-level `const planUsageScraper = createPlanUsageScraper();`
   alongside the existing `const ptyLifecycle = new PtyLifecycle();`.
2. Inside the existing `pty:start` handler's `onData` callback, feed the
   scraper alongside the existing renderer forward:

```ts
ipcMain.handle('pty:start', (event, { cols, rows }: { cols: number; rows: number }) => {
  const sender = event.sender;
  ptyLifecycle.start(() => spawnPty(cols, rows), {
    onData: (data) => {
      if (!sender.isDestroyed()) sender.send('pty:data', data);
      planUsageScraper.ingest(data);
    },
    onAlive: () => sendToWindow('pty:alive', undefined),
    onExit: () => {
      sendToWindow('pty:exit', undefined);
      planUsageScraper.reset(); // a new pty means a fresh /usage read next time -- stale buffer text from the old session must not leak in
    },
  });
  liveAgentTracker.notifyPtySpawned(Date.now());
});
```

3. New `plan:sync` handler, directly porting TokenMonitor's polling loop
   (`src/main/main.js` lines 247-281) onto `ptyLifecycle`/`planUsageScraper`,
   with the `'pro'`-on-quiescence-with-no-model-line addition TokenMonitor's
   own handler doesn't need (TokenMonitor's `usageScraper.ingest` always
   produces *some* snapshot once session+week parse; this scraper only
   produces one when a model line specifically appears, so "no model line
   after quiescence" must be treated as a valid `'pro'` result, not a
   failure):

```ts
ipcMain.handle('plan:sync', async () => {
  if (!ptyLifecycle.current) return { ok: false, error: 'no terminal' };
  const before = planUsageScraper.getSnapshot()?.capturedAtMs ?? 0;
  ptyLifecycle.write('/usage\r');
  // Same quiescence rule as TokenMonitor's plan:sync (main.js) and for the
  // same reason: /usage repaints an unsettled frame before the model line
  // (if any) renders, so a fresh parse alone is not enough signal to Esc.
  const deadline = Date.now() + 10000;
  let lastCapturedAt = before;
  let lastChangeAt: number | null = null;
  let sawAnyFreshParse = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const snap = planUsageScraper.getSnapshot();
    const capturedAt = snap?.capturedAtMs ?? 0;
    if (capturedAt > before) {
      sawAnyFreshParse = true;
      if (capturedAt !== lastCapturedAt) {
        lastCapturedAt = capturedAt;
        lastChangeAt = Date.now();
      } else if (lastChangeAt !== null && Date.now() - lastChangeAt >= 2000) {
        ptyLifecycle.write('\x1b');
        return { ok: true, tier: snap!.tier, weekModel: snap!.weekModel, capturedAtMs: snap!.capturedAtMs };
      }
    }
  }
  ptyLifecycle.write('\x1b');
  if (sawAnyFreshParse) {
    const snap = planUsageScraper.getSnapshot()!;
    return { ok: true, tier: snap.tier, weekModel: snap.weekModel, capturedAtMs: snap.capturedAtMs };
  }
  // Deadline hit with no model line ever seen. Distinguish "confirmed Pro"
  // from "the pane never opened at all" (claude not running in this pty,
  // wrong shell, etc.) using the liveness flag -- see planUsageScraper.ts.
  const confirmedPro = planUsageScraper.hasSeenUsagePane();
  planUsageScraper.reset(); // clears the buffer AND the liveness flag for the next sync
  if (confirmedPro) return { ok: true, tier: 'pro', weekModel: null, capturedAtMs: Date.now() };
  return { ok: false, error: 'could not read /usage' };
});
```

### Persistence approach — no separate config file

TokenMonitor persists plan usage via a dedicated main-process JSON file
(`src/shared/planUsageConfig.js`). aether-os persists this the same way it
persists everything else, through `src/state/persistence.ts`'s
existing `savePersisted`/`loadPersisted` (`localStorage`-backed, renderer
side) rather than a separate main-process JSON file — aether-os has no
existing precedent for a second, main-process-owned persisted-config file
alongside `persistence.ts`, and introducing one would be a second source
of truth for state that otherwise lives entirely in `AetherState`. No new
file is actually needed here; `state.planUsageTier` (next section) *is*
the persisted shape.

### `src/state/types.ts` (modified)

```ts
export interface PlanUsageTier {
  tier: 'pro' | 'max';
  weekModel: { pct: number } | null;
  capturedAtMs: number;
}
```

Add to `AetherState`:

```ts
planUsageTier: PlanUsageTier | null;
```

### `src/state/initialState.ts` (modified)

```ts
planUsageTier: null,
```

### `src/state/reducer.ts` (modified)

New action:

```ts
| { type: 'SET_PLAN_USAGE_TIER'; snapshot: PlanUsageTier }
```

New case:

```ts
case 'SET_PLAN_USAGE_TIER':
  return { ...state, planUsageTier: action.snapshot };
```

No side effects, no interaction with any other reducer case — this is a
pure replace, matching e.g. `SELECT_REAL_AGENT`'s single-field-set shape.

### `src/state/persistence.ts` (modified)

Add to `savePersisted`'s slice:

```ts
planUsageTier: state.planUsageTier,
```

**Not** added to `PERSISTENCE_EXCLUSIONS` — this is the one deliberately
persisted piece of this feature (see Context: tier rarely changes, and a
per-model week % is still meaningful minutes-to-hours old, unlike this
app's other per-session live feeds). The existing coverage test in
`persistence.test.ts` (`round-trips every persisted key`) will fail
loudly if this addition is forgotten, per that file's own stated purpose.

### `src/aetherElectron.d.ts` and `electron/preload.ts` (modified)

```ts
// aetherElectron.d.ts, inside the aetherElectron interface:
plan: {
  sync: () => Promise<PlanUsageSyncResult>;
};
```

```ts
export interface PlanUsageSyncResult {
  ok: boolean;
  tier?: 'pro' | 'max';
  weekModel?: { pct: number } | null;
  capturedAtMs?: number;
  error?: string;
}
```

```ts
// preload.ts, matching the app.getVersion()/pty.start() invoke pattern:
plan: {
  sync: (): Promise<PlanUsageSyncResult> => ipcRenderer.invoke('plan:sync'),
},
```

### `src/components/terminal/PlanUsageCard.tsx` (new)

Takes `SystemOverviewCard`'s old slot in `TerminalView.tsx`'s rail
(`<PlanUsageCard />` first, then unchanged `<ActiveAgentsCard />`,
`<LiveOutputCard />`). Structure, following this codebase's established
card conventions (`cardStyle`/`titleStyle` constants, `useColors()`,
`useAetherStore()`):

- Title row: `"PLAN USAGE"` (left) + tier badge (right — `"PRO"` / `"MAX"`
  / `"—"` if `state.planUsageTier` is `null`) + Sync button (small, like
  `SystemsCard`'s `viewAllStyle` button; disabled when
  `!state.terminalAlive` or a local `syncState === 'syncing'`).
- Session (5h) bar: reuses `deriveDepletion`/`formatResetCountdown`
  (`src/shared/depletion.ts`, already imported elsewhere) against
  `state.statusline` for percentage + "resets in Xh Ym"; renders "no
  reading yet" when `state.statusline` is `null` (matches
  `formatContextLine`'s existing honesty convention in
  `commands.ts`).
- Week (7d) bar: same pattern, reading `state.statusline.sevenDay`
  directly (no existing `deriveDepletion`-equivalent for the 7-day window
  — compute percentage/reset inline, same shape as the 5-hour case).
- Week (model) bar: rendered only when
  `state.planUsageTier?.weekModel` is present.
- Freshness line for the tier/model data specifically: `"as of Xm ago"`
  from `state.planUsageTier.capturedAtMs`, or `"never synced — press
  Sync"` when `null`, or `"last sync failed"` overlaid when the local
  `syncState === 'failed'` (mirrors `budgets.js`'s exact `planSection`
  behavior: a failed sync leaves the last-good snapshot on screen with a
  failure note appended, never blanks it).
- `onClick` for Sync: `await window.aetherElectron.plan.sync()`; on
  `res.ok`, `dispatch({ type: 'SET_PLAN_USAGE_TIER', snapshot: { tier:
  res.tier!, weekModel: res.weekModel ?? null, capturedAtMs:
  res.capturedAtMs! } })`; on failure, set local `syncState = 'failed'`
  without dispatching (matches `budgets.js`).

## Data flow

Two independent paths into this one card, matching the Context section's
"half already-live, half manually-synced" split:

1. **Session/Week bars**: `statuslineWatcher` (main) → IPC
   `statusline:onSnapshot` → existing `useStatuslineSync`-equivalent hook
   → `SET_STATUSLINE`-equivalent reducer action (already exists,
   untouched by this work) → `state.statusline` → read directly by
   `PlanUsageCard` on every render. No new plumbing.
2. **Tier/model bar**: user clicks Sync → `window.aetherElectron.plan.sync()`
   → IPC `plan:sync` (main) → writes `/usage\r` into the live
   `ptyLifecycle` pty → `planUsageScraper.ingest` (fed from the same
   `pty:start` `onData` callback the renderer's own `pty:data` stream
   already uses) → quiescence detected → Escape sent → result returned to
   renderer → `SET_PLAN_USAGE_TIER` dispatched → `state.planUsageTier` →
   persisted via `savePersisted` on the next save tick.

## Error handling / edge cases

- **No live pty** (`state.terminalAlive === false`, e.g. Terminal tab
  never opened): Sync button disabled in the UI; `plan:sync` also
  independently guards on `!ptyLifecycle.current` server-side (defense in
  depth — a disabled button shouldn't be the only thing preventing this
  call).
- **pty exits mid-sync**: not explicitly guarded by the polling loop
  above. With the liveness fix, this now correctly surfaces as
  `ok: false` (no `/usage` pane text was seen) rather than a false "Pro,"
  *provided the exit happens before any output was captured*. If the pty
  exits **after** the pane opened but **before** quiescence, the loop
  still times out on `sawAnyFreshParse: true` and returns the
  last-captured snapshot as if it were fresh (writing an Escape into a
  now-dead pty is a harmless no-op via `PtyLifecycle.write`'s `this.active
  ?.write(...)` optional-chaining). **Accepted as a known limitation**,
  not solved this phase: worst case is one stale-but-real reading,
  self-corrected by the next successful sync — the same class of
  acceptable gap this project's Phase-4 spec documents for
  `agents:completed` never firing (see that spec's own Error
  handling section for the precedent this follows).
- **Concurrent syncs**: the UI's local `syncState === 'syncing'` disables
  the button, but nothing server-side prevents two overlapping `plan:sync`
  calls if triggered another way (there isn't one today, but future code
  could add one). Not guarded server-side, matching TokenMonitor's own
  handler, which has the identical gap.
- **`state.statusline` stale** (per `depletion.ts`'s existing
  `STATUSLINE_STALE_AFTER_MS` / 10-minute rule): Session/Week bars should
  visually flag staleness the same way `ReactorStatusCard`'s existing
  source chips do (`LIVE`/`STALE`/`EST`) — reuse that exact chip component
  or pattern rather than inventing a new one.

## Testing

**Unit tests** (`electron/ansiStrip.test.ts`, new, TDD): direct port of
TokenMonitor's own `ansiStrip.test.js` cases (CSI/OSC/other-escape/C0
stripping, `\n`/`\t`/`\r` preserved, `null`/`undefined` input handled).

**Unit tests** (`electron/planUsageScraper.test.ts`, new, TDD):
- `ingest` sets `tier: 'max'` and a `weekModel.pct` once a model-week line
  appears in the buffer.
- `ingest` never sets a snapshot when only a non-model week line (or no
  week line at all) has been seen.
- `ingest` uses the LAST match when the buffer contains a repainted
  (earlier + later) model line, mirroring `usageParser.js`'s own
  `lastMatch` behavior.
- `ingest` never throws on garbage/partial ANSI-laden input.
- `hasSeenUsagePane()` is `false` before any `/usage`-pane text is
  ingested, and `true` once a "Current session" line appears — even
  without a model line (the Pro case).
- `reset()` clears the buffer, the snapshot's staleness (a subsequent
  `ingest` of the SAME text re-matches, i.e. `reset` doesn't leave a
  match cached), AND `hasSeenUsagePane()` back to `false`.

**Reducer tests** (`src/state/reducer.test.ts`): `SET_PLAN_USAGE_TIER`
replaces `state.planUsageTier` and touches nothing else.

**Persistence tests** (`src/state/persistence.test.ts`): round-trip
`planUsageTier` through `savePersisted`/`loadPersisted`; the file's
existing exhaustiveness test covers the "forgot to persist or exclude"
class of bug automatically once this field is added to the slice.

**Component tests** (`src/components/terminal/PlanUsageCard.test.tsx`,
new): never-synced state (tier badge shows "—", "never synced" freshness
line); synced Pro (no model bar); synced Max with model bar; syncing
(button disabled, "Syncing..." label); sync failure (last-good snapshot
still shown, failure note appended); Sync button disabled when
`state.terminalAlive` is `false`.

**Manual verification (via `npm run electron:dev`):**
1. Open the Terminal tab (pty becomes alive) — Sync button enables.
2. Click Sync with a real Pro-tier `claude` session running; confirm tier
   badge shows "PRO", no model bar, freshness line updates.
3. (If a Max account is available) confirm tier badge shows "MAX" and the
   model bar appears with a real percentage.
4. Confirm Session/Week bars update live (independent of Sync) as
   `state.statusline` pushes new snapshots.
5. Close the Terminal tab's pty (or never open it) — confirm Sync button
   is disabled and `plan:sync` isn't reachable.
6. Restart the app after a successful sync — confirm the tier badge and
   freshness line survive (persisted), while Session/Week bars correctly
   show "no reading yet" until the first fresh statusline snapshot of the
   new session arrives.
