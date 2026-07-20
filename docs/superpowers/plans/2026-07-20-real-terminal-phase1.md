# Real Terminal (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Terminal view's fake typed-command surface with a real `node-pty`-spawned `claude` CLI session rendered via `xterm.js`, persisting across tab switches, while preserving every other simulated system exactly as it is and preserving manual memory creation via a new home in the Memory view.

**Architecture:** A new `electron/ptyManager.ts` + IPC handlers in `electron/main.ts`/`electron/preload.ts` (mirroring TokenMonitor's proven pattern); a new `PtyTerminal.tsx` using a module-level singleton so the real session survives `viewRegistry.ts`'s per-tab unmount/remount; removal of the now-dead `cmdVal`/`termHist`/`histIdx` state and the `'clear'` command it existed for; a small new `remember` input in the Memory view preserving manual memory creation.

**Tech Stack:** `node-pty` `^1.0.0` (matching TokenMonitor), `@xterm/xterm` + `@xterm/addon-fit` (the actively-maintained xterm packages).

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-20-real-terminal-phase1-design.md` (commits `aada21a`, amended at `c317404`) — every requirement below is copied verbatim from it.
- `node-pty`, `@xterm/xterm`, `@xterm/addon-fit` are real `dependencies` (runtime code), not `devDependencies`.
- The pty's cwd is fixed to `os.homedir()` — no folder/project picker this phase.
- No custom clipboard Ctrl+C/Ctrl+V handling this phase.
- No changes to any `commands.ts` case body except removing `'clear'` — `spawn`/`kill`/`theme`/`renderer`/`sweep`/`status`/`help`/`budget`/`projects`/`approvals`/`approve`/`deny`/`remember` are all untouched.
- No changes to `ReactorCore`, `SystemOverviewCard`, `ActiveAgentsCard`, or `LiveOutputCard`.
- **The real terminal session must survive the Terminal tab being unmounted and remounted** (switching to another tab and back) — this is the module-level-singleton requirement in Task 2, not optional.
- `persistence.ts` needs **no changes** — `cmdVal`/`termHist`/`histIdx` were never in its save whitelist.
- Baseline: 272 passing tests across 26 files, clean `tsc -b`, clean `npm run build`, working tree clean at commit `c317404` (the amended spec commit).

---

### Task 1: Electron pty backend (main process)

**Files:**
- Create: `electron/ptyManager.ts`
- Create: `src/aetherElectron.d.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `pty:start`/`pty:write`/`pty:resize`/`pty:data` IPC channels; `window.aetherElectron.pty.{start,write,resize,onData}` (typed via the new global `.d.ts`) — consumed by Task 2's `PtyTerminal.tsx`.

- [ ] **Step 1: Install `node-pty`**

Run: `npm install --save node-pty@^1.0.0`

- [ ] **Step 2: Write `electron/ptyManager.ts`**

```ts
import * as pty from 'node-pty';
import os from 'node:os';

// The terminal ALWAYS starts a fresh claude session -- never add
// resume flags (--continue/--resume/-c/-r) here, matching this app's
// own existing decision (and TokenMonitor's identical one) that the
// terminal never opens on a stale session.
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

- [ ] **Step 3: Modify `electron/main.ts`**

Add the import and the pty wiring. Current file (for reference — do not otherwise change `createWindow`/`app.whenReady`/`window-all-closed`):

```ts
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import { spawnPty } from './ptyManager';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
    },
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let activePty: ReturnType<typeof spawnPty> | null = null;

ipcMain.handle('pty:start', (event, { cols, rows }: { cols: number; rows: number }) => {
  // Kills any prior pty so a renderer reload doesn't orphan its shell/claude
  // session. In normal use this only ever fires once per app launch --
  // PtyTerminal.tsx's module-level singleton means pty:start is only called
  // the first time the Terminal tab is ever visited, not on every remount.
  if (activePty) {
    activePty.kill();
    activePty = null;
  }
  activePty = spawnPty(cols, rows);
  activePty.onData((data) => {
    event.sender.send('pty:data', data);
  });
});

ipcMain.on('pty:write', (_event, input: string) => {
  activePty?.write(input);
});

ipcMain.on('pty:resize', (_event, { cols, rows }: { cols: number; rows: number }) => {
  activePty?.resize(cols, rows);
});
```

- [ ] **Step 4: Modify `electron/preload.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('aetherElectron', {
  pty: {
    start: (opts: { cols: number; rows: number }) => ipcRenderer.invoke('pty:start', opts),
    write: (input: string) => ipcRenderer.send('pty:write', input),
    resize: (cols: number, rows: number) => ipcRenderer.send('pty:resize', { cols, rows }),
    onData: (callback: (data: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: string) => callback(data);
      ipcRenderer.on('pty:data', listener);
      // Returned so a caller CAN unsubscribe if it ever needs to -- Task 2's
      // PtyTerminal deliberately does not call this (the singleton's pty
      // connection is meant to live for the app's whole lifetime), but the
      // capability should exist rather than be silently impossible.
      return () => ipcRenderer.removeListener('pty:data', listener);
    },
  },
});
```

- [ ] **Step 5: Create `src/aetherElectron.d.ts`**

```ts
export {};

declare global {
  interface Window {
    aetherElectron?: {
      pty: {
        start: (opts: { cols: number; rows: number }) => Promise<void>;
        write: (input: string) => void;
        resize: (cols: number, rows: number) => void;
        onData: (callback: (data: string) => void) => () => void;
      };
    };
  }
}
```

- [ ] **Step 6: Verify the existing suite is undisturbed, then verify the Electron build**

Run: `npm test && npx tsc -b && npm run build`
Expected: 272/272 tests, 26 files, 0 type errors, `dist/` build succeeds — unchanged from before this task.

Run: `npx tsc -p electron/tsconfig.json` (editor-only typecheck for the `electron/` project, per Phase 0's existing convention)
Expected: 0 errors.

Run: `npm run electron:build`
Expected: succeeds. This does not exercise `node-pty` at runtime (that's Step 7), but confirms the new imports/IPC code at least compiles and bundles.

- [ ] **Step 7: Manual verification — pty actually spawns**

Run: `npm run electron:dev`. Since Task 2 hasn't wired up the renderer side yet, there's no visible terminal UI change yet — verify at the process level instead: confirm the app launches without throwing, and (if you have a way to inspect it) that invoking `window.aetherElectron.pty.start({cols:80,rows:24})` from the Electron window's dev tools console resolves without error and that a `claude` process appears in the OS process list. If you have no way to run this check, note explicitly in your report that this step is deferred to Task 2's fuller manual verification (where the effect becomes visibly checkable through the real UI).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json electron/ptyManager.ts electron/main.ts electron/preload.ts src/aetherElectron.d.ts
git commit -m "feat: add real node-pty backend for the Terminal view"
```

---

### Task 2: PtyTerminal component (persistent) + TerminalView wiring

**Files:**
- Create: `src/components/terminal/PtyTerminal.tsx`
- Modify: `src/components/terminal/TerminalView.tsx`
- Modify: `package.json`

**Interfaces:**
- Consumes: `window.aetherElectron.pty` (Task 1, typed via `src/aetherElectron.d.ts`).
- Produces: `PtyTerminal` component, rendered by `TerminalView.tsx` in place of the old scrollback + input bar.

- [ ] **Step 1: Install xterm packages**

Run: `npm install --save @xterm/xterm @xterm/addon-fit`

- [ ] **Step 2: Write `src/components/terminal/PtyTerminal.tsx`**

```tsx
import { useEffect, useRef, type CSSProperties } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { colors, fonts } from '../../styles/tokens';
import '@xterm/xterm/css/xterm.css';

// Module-level (not component state) so the real claude session survives
// PtyTerminal being unmounted/remounted every time the user switches away
// from the Terminal tab and back -- viewRegistry.ts fully unmounts view
// components on tab change, unlike TokenMonitor's terminal, which is never
// conditionally unmounted. A detached DOM node stays fully alive in memory
// as long as this module-level variable still references it; re-parenting
// it (appendChild into wherever PtyTerminal currently renders) does not
// recreate it.
let sharedHostEl: HTMLDivElement | null = null;
let sharedTerm: Terminal | null = null;
let sharedFit: FitAddon | null = null;

function getOrCreateHost(): { hostEl: HTMLDivElement; fit: FitAddon } {
  if (!sharedHostEl) {
    sharedHostEl = document.createElement('div');
    sharedHostEl.style.width = '100%';
    sharedHostEl.style.height = '100%';

    sharedTerm = new Terminal({
      fontFamily: fonts.mono,
      fontSize: 13,
      theme: { background: '#06141c', foreground: colors.textBody },
    });
    sharedFit = new FitAddon();
    sharedTerm.loadAddon(sharedFit);
    sharedTerm.open(sharedHostEl);

    // window.aetherElectron.pty is guaranteed present here -- the caller
    // (PtyTerminal's effect) only calls getOrCreateHost() after its own
    // guard confirms it exists.
    const pty = window.aetherElectron!.pty;
    pty.start({ cols: sharedTerm.cols, rows: sharedTerm.rows }); // only ever called once per app lifetime
    pty.onData((data) => sharedTerm!.write(data));
    sharedTerm.onData((input) => pty.write(input));
    sharedTerm.onResize(({ cols, rows }) => pty.resize(cols, rows));
  }
  return { hostEl: sharedHostEl, fit: sharedFit! };
}

export function PtyTerminal() {
  const anchorRef = useRef<HTMLDivElement>(null);
  const hasElectronPty = typeof window !== 'undefined' && !!window.aetherElectron?.pty;

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || !hasElectronPty) return;

    const { hostEl, fit } = getOrCreateHost();
    anchor.appendChild(hostEl);
    fit.fit();

    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(anchor);

    return () => {
      resizeObserver.disconnect();
      // Detach, do not destroy -- the module-level singleton keeps hostEl
      // (and the live xterm/pty session it contains) alive until the
      // Terminal tab is revisited, which re-attaches it via getOrCreateHost().
      hostEl.remove();
    };
  }, [hasElectronPty]);

  if (!hasElectronPty) {
    return <div style={fallbackStyle}>Real terminal requires the Electron app — run `npm run electron:dev`</div>;
  }

  return <div ref={anchorRef} style={hostStyle} />;
}

const hostStyle: CSSProperties = { width: '100%', height: '100%' };
const fallbackStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  font: `400 13px/1.5 ${fonts.mono}`,
  color: colors.textDim,
  textAlign: 'center',
  padding: 20,
};
```

**Note:** verify `@xterm/xterm`'s actual CSS import path (`'@xterm/xterm/css/xterm.css'` above is the expected path for the current package layout, but confirm it resolves — if the installed package uses a different path, correct the import to match, the same "verify and correct" discipline Phase 0 used for its build-output paths).

- [ ] **Step 3: Modify `TerminalView.tsx`**

Replace the whole file with:

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { SystemOverviewCard } from './SystemOverviewCard';
import { ActiveAgentsCard } from './ActiveAgentsCard';
import { LiveOutputCard } from './LiveOutputCard';
import { ReactorCore } from '../reactor/ReactorCore';
import { PtyTerminal } from './PtyTerminal';

export function TerminalView() {
  const { state } = useAetherStore();

  return (
    <div style={rootStyle}>
      <div style={terminalCardStyle}>
        <div style={scanSweepStyle} />
        <div style={headerStyle}>
          <span style={liveDotStyle} />
          <span style={{ font: `400 13px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>operator@aether-core</span>
          <span style={{ font: `400 13px/1 ${fonts.mono}`, color: colors.textDim }}>:~$ session active</span>
          <span style={{ marginLeft: 'auto', font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>TERMINAL · zsh</span>
        </div>

        <div style={termHostStyle}>
          <PtyTerminal />
        </div>

        <div style={coreFloatWrapStyle}>
          <ReactorCore />
        </div>
        <div style={calloutStyle}>Reactor nominal — {state.agents.length} agents drawing power.</div>
      </div>

      <div style={railStyle}>
        <SystemOverviewCard />
        <ActiveAgentsCard />
        <LiveOutputCard />
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
const terminalCardStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  position: 'relative',
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};
const scanSweepStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  height: 150,
  background: 'linear-gradient(180deg, rgba(95,240,255,.08), transparent)',
  animation: 'scan 7s linear infinite',
  pointerEvents: 'none',
};
const headerStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '11px 16px',
  borderBottom: `1px solid ${colors.chromeBorder}`,
};
const liveDotStyle: CSSProperties = { width: 10, height: 10, borderRadius: '50%', background: colors.accentCyanDeep, boxShadow: '0 0 8px rgba(95,240,255,.8)' };
const termHostStyle: CSSProperties = { flex: 1, minHeight: 0, position: 'relative' };
const coreFloatWrapStyle: CSSProperties = {
  position: 'absolute',
  right: 6,
  top: '52%',
  transform: 'translateY(-50%)',
  width: 334,
  height: 334,
  display: 'grid',
  placeItems: 'center',
  pointerEvents: 'none',
};
const calloutStyle: CSSProperties = {
  position: 'absolute',
  right: 100,
  top: 'calc(52% + 176px)',
  padding: '9px 13px',
  borderRadius: '2px 10px 10px 10px',
  border: '1px solid rgba(95,220,255,.3)',
  background: 'rgba(10,34,45,.9)',
  font: `400 12px/1.4 ${fonts.ui}`,
  color: '#bff4ff',
  maxWidth: 146,
  textAlign: 'left',
};
const railStyle: CSSProperties = { width: 332, flex: 'none', display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 };
```

This removes `SPAWN_NAMES`/`BUILD_STEPS`/`CHIPS`, the hardcoded demo transcript, `scrollbackStyle`/`caretStyle`/`inputBarStyle`/`inputRowStyle`/`inputStyle`/`sendButtonStyle`/`chipStyle`, the `submit`/`onKeyDown` handlers, and the `scrollRef`/`useEffect` auto-scroll (xterm manages its own scrollback internally). `dispatch` is no longer needed from `useAetherStore()` in this file since nothing here dispatches anymore — only `state.agents.length` (for the callout) is read.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npm test && npx tsc -b && npm run build`
Expected: 272/272 tests (no new tests this task — `TerminalView.tsx`/`PtyTerminal.tsx` are integration/DOM code, not pure logic), 26 files, 0 type errors, build succeeds.

- [ ] **Step 5: Manual verification**

Run: `npm run electron:dev`.
1. Confirm the Terminal view shows a real xterm surface with the real `claude` CLI actually running (its own banner, not the old fake transcript).
2. Type a real message and confirm a real streamed reply.
3. Resize the window and confirm the grid resizes correctly.
4. **Navigate to another tab (e.g. Agents) and back to Terminal.** Confirm the same session/scrollback is still there, not a fresh `claude` banner — this is the core requirement this task exists to satisfy, verify it explicitly, don't skip it.
5. Run `npm run dev` (plain browser) separately and confirm the Terminal view shows the "Real terminal requires the Electron app" fallback message instead of crashing.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/components/terminal/PtyTerminal.tsx src/components/terminal/TerminalView.tsx
git commit -m "feat: render a real, persistent claude terminal session via xterm.js"
```

---

### Task 3: State cleanup (remove dead cmdVal/termHist/histIdx)

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/reducer.ts`
- Modify: `src/components/terminal/commands.ts`
- Modify: `src/state/reducer.test.ts`
- Modify: `src/components/terminal/commands.test.ts`

**Interfaces:**
- Removes: `AetherState.cmdVal`/`.termHist`/`.histIdx`; `Action`'s `HIST_NAV`/`SET_CMD_VAL` variants; `CommandResult`'s `'clear'` variant.
- After this task, nothing under `src/` references `cmdVal`/`termHist`/`histIdx`/`HIST_NAV`/`SET_CMD_VAL`/`'clear'` at all (Task 2 already removed `TerminalView.tsx`'s usages, so this task only needs to remove the now-unreferenced definitions).

- [ ] **Step 1: `types.ts`**

Remove these three lines from `AetherState` (currently between `selectedMemory` and `notifs`):

```ts
  cmdVal: string;
  termHist: TermLine[];
  histIdx: number;
```

Change `CommandResult` from:

```ts
export type CommandResult =
  | { kind: 'clear' }
  | { kind: 'append'; lines: TermLine[]; patch?: Partial<AetherState> };
```

to:

```ts
export type CommandResult = { kind: 'append'; lines: TermLine[]; patch?: Partial<AetherState> };
```

Keep `TermLine` itself (`{ t: string; c: string }`) — still `CommandResult`'s `lines` element type.

- [ ] **Step 2: `initialState.ts`**

Remove the three seed lines: `cmdVal: '',`, `termHist: [],`, `histIdx: -1,`.

- [ ] **Step 3: `reducer.ts`**

Remove these two variants from the `Action` union:

```ts
  | { type: 'SET_CMD_VAL'; value: string }
  | { type: 'HIST_NAV'; up: boolean }
```

Remove these two `case` blocks entirely:

```ts
    case 'SET_CMD_VAL':
      return { ...state, cmdVal: action.value };
```

```ts
    case 'HIST_NAV': {
      const h = state.cmdHist;
      if (!h.length) return state;
      let i: number;
      if (action.up) i = state.histIdx < 0 ? h.length - 1 : Math.max(0, state.histIdx - 1);
      else {
        i = state.histIdx < 0 ? -1 : state.histIdx + 1;
        if (i >= h.length) i = -1;
      }
      return { ...state, histIdx: i, cmdVal: i < 0 ? '' : h[i] };
    }
```

Simplify the `RUN_COMMAND` case from:

```ts
    case 'RUN_COMMAND': {
      const result = runCommand(state, action.raw);
      if (result.kind === 'clear') {
        return { ...state, termHist: [], cmdVal: '' };
      }
      const base = result.patch ? { ...state, ...result.patch } : state;
      return {
        ...base,
        termHist: [...base.termHist, ...result.lines].slice(-60),
        cmdVal: '',
        cmdHist: [...base.cmdHist, action.raw].slice(-30),
        histIdx: -1,
        commandsRun: base.commandsRun + 1,
      };
    }
```

to:

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

- [ ] **Step 4: `commands.ts`**

Remove the `case 'clear': return { kind: 'clear' };` block (immediately before `default:`).

Remove the `'clear'` entry from the `help` command's line list — find the line reading `line('  clear               clear the terminal'),` (around line 69) and delete it.

- [ ] **Step 5: `reducer.test.ts`**

Remove the entire `'HIST_NAV walks command history backwards then forwards to empty'` test block (currently lines 47-59).

- [ ] **Step 6: `commands.test.ts`**

In the `'help lists every documented command'` test, remove `'clear'` from the array of expected substrings (the array currently ends `..., 'theme <name>', 'renderer <mode>', 'clear']`).

Remove the entire `'clear returns the clear variant'` test block:

```ts
  it('clear returns the clear variant', () => {
    expect(runCommand(initialState, 'clear')).toEqual({ kind: 'clear' });
  });
```

- [ ] **Step 7: Run the full suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: 270/270 tests (272 minus the 2 removed tests: `HIST_NAV`'s test and `'clear' variant`'s test), 26 files, 0 type errors, build succeeds. If the count differs, check for any other test referencing the removed fields that wasn't caught above.

- [ ] **Step 8: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/reducer.ts src/state/reducer.test.ts src/components/terminal/commands.ts src/components/terminal/commands.test.ts
git commit -m "refactor: remove dead cmdVal/termHist/histIdx state and the clear command"
```

---

### Task 4: Preserve manual memory creation (Memory view `remember` input)

**Files:**
- Modify: `src/components/memory/MemoryRosterCard.tsx`

**Interfaces:**
- Consumes: the existing, untouched `RUN_COMMAND` action and `commands.ts`'s existing, untouched `remember` case.

- [ ] **Step 1: Add the input to `MemoryRosterCard.tsx`**

Add local state for the input's text and a submit handler dispatching the existing command, rendered above the existing `PINNED`/`ENGRAMS` scrollable groups (inside the card, below the `MEMORY` title):

```tsx
import { useState } from 'react';
// ...(existing imports unchanged)

export function MemoryRosterCard({ selectedId }: { selectedId: number | null }) {
  const { state, dispatch } = useAetherStore();
  const { pinned, unpinned } = groupMemoriesForRoster(state.memories);
  const [rememberText, setRememberText] = useState('');

  function submitRemember() {
    const text = rememberText.trim();
    if (!text) return;
    dispatch({ type: 'RUN_COMMAND', raw: `remember ${text}` });
    setRememberText('');
  }

  // ...(existing `row` function unchanged)

  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none' }}>
        <div style={titleStyle}>MEMORY</div>
      </div>

      <div style={{ flex: 'none', display: 'flex', gap: 6, marginTop: 10 }}>
        <input
          value={rememberText}
          onChange={(e) => setRememberText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitRemember();
          }}
          placeholder="remember something..."
          spellCheck={false}
          style={rememberInputStyle}
        />
        <span onClick={submitRemember} style={rememberButtonStyle}>
          +
        </span>
      </div>

      {/* ...(existing scrollable PINNED/ENGRAMS section unchanged below)... */}
    </div>
  );
}
```

Add two new style constants (matching this file's existing style conventions — inline `CSSProperties`, same border/background palette as `rowStyle`/`sourceBadgeStyle`):

```ts
const rememberInputStyle: CSSProperties = {
  flex: 1,
  font: `400 12px/1 ${fonts.mono}`,
  color: colors.textBody,
  background: 'rgba(6,20,28,.7)',
  border: '1px solid rgba(80,190,220,.25)',
  borderRadius: 7,
  padding: '7px 9px',
  outline: 'none',
};
const rememberButtonStyle: CSSProperties = {
  flex: 'none',
  width: 30,
  cursor: 'pointer',
  display: 'grid',
  placeItems: 'center',
  borderRadius: 7,
  border: '1px solid rgba(80,190,220,.25)',
  color: colors.accentCyanSoft,
  font: `700 14px/1 ${fonts.ui}`,
};
```

(`useState` needs adding to this file's React import; every other import in the file stays as-is.)

- [ ] **Step 2: Run the full suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: 270/270 tests (unchanged from Task 3 — no new test file for this small UI addition, matching this project's convention of not requiring a dedicated test for a simple dispatch-on-submit input when the underlying command is already tested in `commands.test.ts`), 26 files, 0 type errors, build succeeds.

- [ ] **Step 3: Manual verification**

Run `npm run dev` or `npm run electron:dev`, go to the Memory view, type text into the new input, submit it, and confirm a new memory entry appears in the roster with the typed text as its content and `'operator'` as its source — identical in shape to what typing `remember <text>` into the old terminal input used to produce.

- [ ] **Step 4: Commit**

```bash
git add src/components/memory/MemoryRosterCard.tsx
git commit -m "feat: preserve manual memory creation via a remember input in the Memory view"
```

---

### Task 5: Final integration QA

**Files:** None (verification only).

- [ ] **Step 1: Re-run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: 270/270 tests, 26 files, 0 type errors, build succeeds.

- [ ] **Step 2: Manual GUI verification checklist**

Using `npm run electron:dev`:
1. Terminal shows a real xterm surface running the real `claude` CLI (not the old fake transcript).
2. A typed message gets a real, streamed reply.
3. Window resize keeps the terminal grid correct.
4. **Navigating away from Terminal and back preserves the same session** (the core requirement of this phase — verify explicitly).
5. Memory view's new `remember` input creates a real memory entry.
6. Every other simulated surface still works: Agents' spawn/kill, Dashboard's spawn/sweep, Settings' theme/renderer toggles, Terminal's own side-rail spawn button.
7. `npm run dev` (plain browser) shows the Terminal's "Real terminal requires the Electron app" fallback instead of crashing.

- [ ] **Step 3: Report results**

No commit for this task (verification only) unless a regression is found, in which case fix it, re-run Steps 1-2, and commit the fix separately.
