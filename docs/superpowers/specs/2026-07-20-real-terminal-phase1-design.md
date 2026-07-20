# Real Terminal (Phase 1) — Design

## Context

Phase 0 (shipped) added an additive Electron scaffold — `electron/main.ts`,
`electron/preload.ts`, `electron.vite.config.ts` — with no real IPC yet.
Phase 1 is the first phase that adds real functionality: the Terminal view's
typed-command surface, currently a fully fake simulation, becomes a real
`node-pty`-spawned `claude` CLI session rendered via `xterm.js`, directly
mirroring the sibling project TokenMonitor's `ptyManager.js`/`terminal.js`
pattern (confirmed by reading that project's actual source this session, not
from memory).

A full trace of `RUN_COMMAND`/`commands.ts`/`cmdHist` usage (grepped across
the whole codebase before this design) found it is **not** Terminal-only
infrastructure — it's the shared simulation bus for: Agents' spawn/kill
buttons (`AgentRosterCard.tsx`, `AgentDetailCard.tsx`), Dashboard's
`ReactorStatusCard` spawn/sweep buttons, Settings' `AppearanceCard`
theme/renderer toggles, Chat's `useChatChannels.ts` action executor
(AI-driven), and the Terminal's own side-rail `ActiveAgentsCard` spawn button.
None of these change in this phase — only the Terminal's own typed-input path
(the input bar + `CHIPS` quick-buttons + the hardcoded demo transcript) is
replaced.

That trace also surfaced two real consequences, both resolved with the user
before writing this spec:
1. `state.cmdVal`/`termHist`/`histIdx` and the `HIST_NAV`/`SET_CMD_VAL`
   actions become genuinely dead code once the Terminal's typed-input path is
   gone (nothing else reads them) — **to be removed**, matching this
   project's own precedent (the original scaffold's whole-branch review
   removed a dead `HYDRATE` action for the same reason).
2. Removing `termHist` makes `commands.ts`'s `'clear'` case and
   `CommandResult`'s `'clear'` variant unreachable too (they exist solely to
   clear `termHist`) — **to be removed** as a required consequence, not
   optional scope; confirmed via grep that `reducer.ts`'s
   `result.kind === 'clear'` branch is the only consumer (Chat's
   `useChatChannels.ts` only ever checks for `'append'`).

A further, more consequential finding: several fictional commands
(`help`/`status`/`budget`/`projects`/`approvals`/`approve`/`deny`) were only
ever reachable by typing them into the now-removed input bar or clicking the
now-removed `CHIPS` — they have no other dispatcher anywhere in the app.
Losing typed access to these is accepted as harmless (their information is
already visible elsewhere in the real UI: status/budget in the dashboard,
projects in the Projects view, approvals via the TopBar bell and
`AgentDetailCard`'s own approve/deny buttons, which use `RESOLVE_APPROVAL`
directly, not `commands.ts`'s redundant typed `approve`/`deny` path). **One
command is not harmless to lose**: `remember <text>` is, per this project's
own Memory view design, "deliberately terminal-only — no '+ add' roster
button" — the *only* way to manually create a Memory entry. This spec adds a
minimal `remember` input to the Memory view so that capability survives,
reusing `commands.ts`'s existing `remember` case verbatim via the same
`RUN_COMMAND` dispatch path Settings' theme picker already uses — no new
reducer action, no new command logic.

## Goal

Replace the Terminal view's fake typed-command surface with a real
`node-pty`-spawned `claude` CLI session rendered via `xterm.js`, while
preserving every other simulated system in the app exactly as it is today,
and preserving manual memory creation via a small new home in the Memory
view.

## Non-goals

- **No folder/project picker.** The pty's cwd is fixed to `os.homedir()`.
  TokenMonitor's project-switcher (folder bar, `projects.js`) is a whole
  separate feature in that project's own history — not folded in here.
- **No custom clipboard handling.** TokenMonitor's Ctrl+C/Ctrl+V
  copy-vs-SIGINT logic is deferred as a later polish pass; this phase accepts
  xterm's default keyboard-to-pty forwarding as-is.
- **No packaging** (still Phase 0's non-goal, still true).
- **No changes to `commands.ts`'s simulation logic** for `spawn`/`kill`/
  `theme`/`renderer`/`sweep`/`status`/`help`/`budget`/`projects`/`approvals`/
  `approve`/`deny`/`remember` — every case body is untouched. Only the
  `'clear'` case (and its `CommandResult` variant) is removed, as a required
  consequence of removing `termHist`, not a behavior change to any other
  command.
- **No change to Analytics' Top Commands card or the footer's Top Commands**
  (`computeTopCommands(state.cmdHist)`). Real text typed directly into the
  `claude` session bypasses `RUN_COMMAND`/`cmdHist` entirely (it goes straight
  into the pty) — Top Commands will only ever reflect UI-button-triggered
  fictional commands after this phase. Accepted; reconciling this against
  real usage data is Phase 2/3's job (real session-data ingestion), not this
  phase's.
- **No changes to `ReactorCore`, `SystemOverviewCard`, `ActiveAgentsCard`, or
  `LiveOutputCard`** — all stay exactly as fictional/simulated as they are
  today. Real data is a later phase's concern.

## Architecture

### `electron/ptyManager.ts` (new)

Mirrors TokenMonitor's `src/main/ptyManager.js` structure directly:

```ts
import * as pty from 'node-pty';
import os from 'node:os';

const CLAUDE_LAUNCH_COMMAND = 'claude\r';

export function spawnPty(cols = 100, rows = 30) {
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash';
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols,
    rows,
    cwd: os.homedir(),
    env: process.env,
  });
  ptyProcess.write(CLAUDE_LAUNCH_COMMAND);
  return ptyProcess;
}
```

Fixed home-directory cwd (Non-goals) and an always-fresh `claude` launch —
matching aether-os's own already-documented decision that the Terminal never
resumes a prior session, and TokenMonitor's identical policy for the same
reason (a fresh session on every launch, never someone else's pending
approval prompt).

### `electron/main.ts` (modified)

Adds a module-level `activePty` plus three IPC handlers, mirroring
TokenMonitor's `main.js` exactly: `pty:start` (kills any prior pty first,
spawns a fresh one, forwards its output via `event.sender.send('pty:data', ...)`),
`pty:write` (writes renderer input to the pty), `pty:resize` (keeps the pty's
size in lockstep with the visible grid). No usage-scraping, no folder
resolution — those are TokenMonitor-specific features this phase doesn't need.

### `electron/preload.ts` (modified)

Extends the empty `aetherElectron` stub from Phase 0 with a real `pty` surface:

```ts
contextBridge.exposeInMainWorld('aetherElectron', {
  pty: {
    start: (opts: { cols: number; rows: number }) => ipcRenderer.invoke('pty:start', opts),
    write: (input: string) => ipcRenderer.send('pty:write', input),
    resize: (cols: number, rows: number) => ipcRenderer.send('pty:resize', { cols, rows }),
    onData: (callback: (data: string) => void) => ipcRenderer.on('pty:data', (_event, data) => callback(data)),
  },
});
```

### `src/components/terminal/PtyTerminal.tsx` (new)

**Amended after initial approval** to solve a real usability gap found
while planning: aether-os's `viewRegistry.ts`/`App.tsx` fully unmounts a
view's component tree when the active tab changes (unlike TokenMonitor,
whose terminal is never conditionally unmounted during a session). A naive
"create fresh on mount, dispose on unmount" `PtyTerminal` would mean
`pty:start`'s existing "kill any prior pty first" guard fires every time the
user navigates away from Terminal and back — killing the real `claude`
session and starting a new one on every tab revisit. Confirmed with the user
this must be solved in this phase, not deferred, since it undermines the
whole point of a real daily-use terminal.

The fix: the expensive, stateful part (the `@xterm/xterm` `Terminal`
instance, its `FitAddon`, and the pty connection) lives in **module-level
singletons**, not React component state — deliberately outside React's
normal lifecycle, so it survives `PtyTerminal` being unmounted and remounted
as the user switches tabs and back. A detached `HTMLDivElement` hosts the
actual xterm canvas; each mount physically re-parents that *same* element
(`anchorEl.appendChild(hostEl)`) into wherever `PtyTerminal` currently
renders, rather than recreating the terminal. Detaching it on unmount
(`hostEl.remove()`) does not destroy it — a detached DOM node stays fully
alive in memory as long as something still references it, which the
module-level singleton does.

```ts
// Module-level (not component state) so the real claude session survives
// PtyTerminal being unmounted/remounted on every Terminal <-> other-tab
// switch -- viewRegistry.ts fully unmounts view components, unlike
// TokenMonitor's terminal, which is never conditionally unmounted.
let sharedHostEl: HTMLDivElement | null = null;
let sharedTerm: Terminal | null = null;
let sharedFit: FitAddon | null = null;

function getOrCreateHost() {
  if (!sharedHostEl) {
    sharedHostEl = document.createElement('div');
    sharedTerm = new Terminal({ /* theme, font */ });
    sharedFit = new FitAddon();
    sharedTerm.loadAddon(sharedFit);
    sharedTerm.open(sharedHostEl);

    const pty = window.aetherElectron!.pty;
    pty.start({ cols: sharedTerm.cols, rows: sharedTerm.rows }); // only ever called once
    pty.onData((data) => sharedTerm!.write(data));
    sharedTerm.onData((input) => pty.write(input));
    sharedTerm.onResize(({ cols, rows }) => pty.resize(cols, rows));
  }
  return { hostEl: sharedHostEl, fit: sharedFit! };
}
```

- `useEffect` on mount: guard on `window.aetherElectron?.pty` (absent under
  plain `npm run dev` — renders a centered "Real terminal requires the
  Electron app — run `npm run electron:dev`" message instead, matching this
  project's empty-state-message convention rather than crashing). If
  present: call `getOrCreateHost()`, `anchorRef.current.appendChild(hostEl)`,
  `fit.fit()`, attach a `ResizeObserver` on the anchor calling `fit.fit()` on
  size changes.
- Cleanup on unmount: disconnect the `ResizeObserver` and `hostEl.remove()`
  (detaches, does not destroy — the module-level singleton keeps it alive).
  The `Terminal` instance itself is never disposed and `pty:start` is never
  called again after the first mount, so the same real session persists for
  the app's entire lifetime, not just while the Terminal tab is visible.
- Since aether-os is already a real Vite/ES-module app (confirmed in Phase
  0's research), this is a plain `import { Terminal } from '@xterm/xterm'` —
  none of TokenMonitor's UMD-script-tag workaround is needed.
- React StrictMode's dev-mode double-invoke (mount → cleanup → remount) is
  handled correctly for free: `getOrCreateHost()`'s `if (!sharedHostEl)`
  guard makes it idempotent — a double-invoke just re-attaches the same
  already-created host, it never spawns a second session.

### `src/components/terminal/TerminalView.tsx` (modified)

Removes: the `SPAWN_NAMES`/`BUILD_STEPS`/`CHIPS` constants, the hardcoded
demo transcript JSX, the `scrollbackStyle` div and its `state.termHist`
rendering, the entire `inputBarStyle` input bar (input field + send button +
chip row), and the `submit`/`onKeyDown` handlers tied to `cmdVal`/`HIST_NAV`.

Adds: `<PtyTerminal />` rendered in the space the scrollback + input bar
occupied. The header (`operator@aether-core :~$ session active`), the
`ReactorCore` floating overlay, the callout, and the side rail
(`SystemOverviewCard`/`ActiveAgentsCard`/`LiveOutputCard`) are all unchanged —
`ActiveAgentsCard`'s own spawn button keeps dispatching the existing
fictional `RUN_COMMAND` exactly as it does today.

### State cleanup (`src/state/`)

- `types.ts`: remove `cmdVal`, `termHist`, `histIdx` from `AetherState`;
  remove the `'clear'` variant from `CommandResult` (keep `TermLine` — it's
  still `CommandResult`'s `'append'` variant's `lines` type, still generated
  by every other command case, just no longer rendered anywhere).
- `initialState.ts`: remove the `cmdVal: ''`, `termHist: []`, `histIdx: -1`
  seed lines.
- `reducer.ts`: remove the `HIST_NAV` and `SET_CMD_VAL` action variants and
  their `case` blocks entirely. Simplify `RUN_COMMAND`'s case to drop the
  `result.kind === 'clear'` branch and stop writing to the removed fields:

  ```ts
  case 'RUN_COMMAND': {
    const result = runCommand(state, action.raw);
    const base = result.patch ? { ...state, ...result.patch } : state;
    return {
      ...base,
      cmdHist: [...base.cmdHist, action.raw].slice(-30),
      commandsRun: base.commandsRun + 1,
    };
  }
  ```
- `persistence.ts`: **no change needed** — `cmdVal`/`termHist`/`histIdx` were
  never in the save whitelist to begin with (confirmed by reading the file;
  only `cmdHist` is persisted today, and that stays exactly as-is).
- `src/components/terminal/commands.ts`: remove the `case 'clear': return {
  kind: 'clear' };` block and its "clear the terminal" line from the `help`
  command's text (`commands.ts:69`). Every other case is untouched.

### Memory view: `remember` input (new, small addition)

A single labeled text input added to the top of `MemoryRosterCard.tsx`
(above the existing PINNED/ENGRAMS scrollable groups, matching the
project's established "single labeled input" convention used by
`OperatorCard`), dispatching on submit:

```ts
dispatch({ type: 'RUN_COMMAND', raw: `remember ${text}` });
```

Reuses `commands.ts`'s existing `remember` case verbatim — no new reducer
action, no new command logic, no change to the `MemoryStub` shape or its
`source: 'operator'` tag (which stays exactly as-is, per the Operator Name
feature's own established non-goal that this tag is unrelated to the display
name). This is the same dispatch pattern Settings' `AppearanceCard` already
uses for `theme`/`renderer`.

### New dependencies

- `node-pty` (`^1.0.0`, matching TokenMonitor) — a real `dependency` (runtime
  code in the main process), not a `devDependency`.
- `@xterm/xterm` and `@xterm/addon-fit` — real `dependencies` (bundled into
  the renderer's shipped output), not `devDependencies`.

### One thing this spec cannot fully guarantee up front

Whether `electron-vite`'s main-process build correctly externalizes
`node-pty`'s native binary without extra `rollupOptions.external`
configuration. Phase 0 already established the right way to handle this
class of uncertainty: write a reasonable config, then empirically verify
during implementation and correct if wrong (exactly how Phase 0's
build-output-path guess was caught and fixed) — not assume correctness
without checking.

## Data flow

`PtyTerminal` mounts → `pty:start` IPC call → main process kills any prior
pty, spawns a fresh shell via `ptyManager.spawnPty`, writes `'claude\r'` →
the shell's/claude's combined stdout/stderr streams back through
`pty:data` → `term.write(data)` renders it in xterm. Keystrokes in the
xterm surface go through `term.onData` → `pty:write` → the pty's stdin.
Resizing the window or the container triggers `fit.fit()` → `term.onResize`
→ `pty:resize`, keeping the real shell's terminal size in sync with the
visible grid.

Separately, and unrelated to the above: `RUN_COMMAND` dispatches from every
other UI surface (Agents/Dashboard/Settings/Chat/the Memory view's new
`remember` input/Terminal's own side-rail spawn button) continue to flow
through `commands.ts`'s `runCommand()` exactly as they do today, producing
state patches and `cmdHist` entries — entirely independent of the real pty
session.

## Error handling / edge cases

- **pty spawn failure** (e.g. `claude` not on `PATH`): no special handling in
  this phase — whatever the shell itself prints (a "command not found"-style
  error) renders naturally in xterm, since that's just the shell's own stdout.
- **Component remount** (tab switch away and back, or dev hot-reload):
  handled by the module-level singleton (see Architecture) — `pty:start` is
  only ever called once per app lifetime, so a remount re-attaches the
  existing session instead of triggering `main.ts`'s "kill any prior pty
  first" guard at all. That guard now only matters for a genuine full app
  restart, where the singleton itself is gone and a fresh `pty:start`
  legitimately needs to replace whatever the main process still thinks is
  active from before.
- **Window/container resize**: handled via `ResizeObserver` + `fit.fit()` +
  `term.onResize` → `pty:resize`, matching TokenMonitor's proven pattern.

## Testing

**No new unit tests for the pty/xterm wiring itself** — like Phase 0, this is
real-process/IPC/DOM integration code, not pure application logic Vitest can
meaningfully exercise in `jsdom`.

**Unit tests for the state cleanup** (adjust existing tests, no new test
files needed beyond touch-ups):
- `reducer.test.ts`: remove tests for `HIST_NAV`/`SET_CMD_VAL`; update
  `RUN_COMMAND` tests that referenced `termHist`/`cmdVal` to assert the
  simplified shape instead.
- `commands.test.ts`: remove the test(s) covering `case 'clear'`.
- `viewRegistry.test.ts`/other suites: no changes expected, but re-run in
  full to confirm nothing else silently depended on the removed fields.

**Manual verification (plan-exit):**
1. Launch `npm run electron:dev` — the Terminal view shows a real xterm
   surface; the real `claude` CLI actually starts (its own banner/prompt
   renders, not the old fake transcript).
2. Type a real message to Claude in the terminal and confirm a real reply
   streams back character-by-character (proving the pty pipe is live, not a
   one-shot echo).
3. Resize the Electron window and confirm the terminal's visible grid
   resizes correctly (no clipped or stretched text).
4. **Navigate away from Terminal to another tab (e.g. Agents) and back.**
   Confirm the same real session is still there — the same conversation
   scrollback, not a fresh `claude` banner — proving the module-level
   singleton correctly survived the unmount/remount instead of `pty:start`
   killing and respawning it.
5. Confirm the Memory view's new `remember` input creates a real memory
   entry identical in shape to what typing `remember <text>` used to
   produce (same `source: 'operator'` tag, same 40-char truncation).
6. Confirm every other simulated surface still works unchanged: Agents'
   spawn/kill buttons, Dashboard's spawn/sweep, Settings' theme/renderer
   toggles, and Terminal's own side-rail spawn button.
7. Confirm `npm run dev` (plain browser, no Electron) still loads without
   crashing. `window.aetherElectron` is `undefined` there, so `PtyTerminal`
   guards on `window.aetherElectron?.pty` before mounting xterm at all; if
   absent, it renders a simple centered message ("Real terminal requires the
   Electron app — run `npm run electron:dev`") instead of a blank or
   crashed view, matching this project's existing empty-state-message
   convention (e.g. Memory's "no memories logged yet" state) rather than
   throwing or silently no-op'ing.
