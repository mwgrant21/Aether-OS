# Codex Terminal View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real, interactive `codex` CLI terminal session as its own sidebar view,
mirroring the existing Claude terminal's proven pty pattern rather than the narrower
ACP-based verifier.

**Architecture:** A second, fully independent pty (`electron/codexPtyManager.ts`,
`codexPty:*` IPC channels) spawns a shell and writes `codex\r` into it — the exact
mechanism `electron/ptyManager.ts` already uses for `claude\r`. Liveness tracking reuses
`electron/ptyLifecycle.ts`'s `PtyLifecycle` class unmodified (a second instance). The
renderer mirrors `PtyTerminal.tsx`/`TerminalView.tsx` almost line for line. Billing
safety reuses `resolveCodexHome()` from the already-shipped cross-engine verifier
(`electron/crossEngine/acpProcess.ts`) — one dedicated `CODEX_HOME`, one ChatGPT login,
serves both features.

**Tech Stack:** TypeScript (strict), React 18, Electron, node-pty, xterm.js, Vitest.

## Global Constraints

- Full spec: `docs/superpowers/specs/2026-08-09-codex-terminal-view-design.md`.
- **Dedicated, isolated `CODEX_HOME`, shared with the verifier.** Import
  `resolveCodexHome()` from `electron/crossEngine/acpProcess.ts` — never duplicate it,
  never use the operator's global `~/.codex`.
- **Strip `OPENAI_API_KEY`/`CODEX_API_KEY` from the pty's environment**, the same way
  `buildPtyEnv()` already strips `ANTHROPIC_API_KEY`/etc. for Claude's terminal. Named,
  not silent: a real interactive terminal cannot structurally prevent the operator from
  typing an API key by hand — this reduces the risk (no key present *to* type from the
  environment) but does not eliminate manual entry, same limitation Claude's terminal
  already has and documents.
- **`codexPty:*` is fully independent from `pty:*`.** Two separate ptys, two separate
  `PtyLifecycle` instances, never share state, never touch Claude's terminal code.
- **No cost/token tracking, no Ledger entry, no dispatch/narration integration, no rail
  cards.** Plain terminal only — this is a v1 scope boundary, not an oversight.
- **The existing verifier and its Uplinks/Settings status row are untouched.** This
  feature's own toggle and status are visually distinct from "is my ChatGPT subscription
  connected."
- **Default-off, explicit opt-in required before the pty ever spawns.**
- **Parity with Claude's terminal means the same mount-triggers-spawn mechanism**, not a
  stronger unconditional main-process boot-time spawn — Claude's own terminal only
  spawns when `PtyTerminal.tsx` actually mounts (i.e., when the Terminal view is
  rendered), which only happens unconditionally on a truly fresh `activeTab: 'Terminal'`
  default; a persisted `activeTab` elsewhere means Claude's terminal doesn't spawn at
  launch either. Codex's terminal follows the identical rule once enabled: it spawns
  when `CodexTerminalView` mounts, nothing more special than that.
- `npm test`, `npx tsc -b`, and `npm run build` clean before every commit. Any task
  touching `electron/` also runs `npm run electron:build`.

## File Structure

| File | Responsibility |
|---|---|
| `electron/codexPtyManager.ts` (new) | `buildCodexPtyEnv`, `spawnCodexPty` — mirrors `ptyManager.ts`, launches `codex\r` instead of `claude\r`, uses the shared `resolveCodexHome()`. |
| `electron/codexPtyManager.test.ts` (new) | Env-stripping tests, mirroring `ptyManager.test.ts`. |
| `electron/main.ts` (modify) | `codexPty:start/write/resize` handlers, a second `PtyLifecycle` instance. |
| `electron/preload.ts`, `src/aetherElectron.d.ts` (modify) | `codexPty.{start,write,resize,onData,onAlive,onExit}`, exact mirror of `pty.*`. |
| `src/state/types.ts`, `reducer.ts`, `reducer.test.ts`, `initialState.ts`, `persistence.ts` (modify) | `codexTerminalAlive: boolean` (default `false`), `SET_CODEX_TERMINAL_ALIVE`, persistence exclusion. |
| `src/state/useCodexTerminalAliveSync.ts` (new) | Mirrors `useTerminalAliveSync.ts`. |
| `src/App.tsx` (modify) | Mount `CodexTerminalAliveSync` wrapper alongside the existing `TerminalAliveSync`. |
| `src/components/codexTerminal/PtyCodexTerminal.tsx` (new) | Mirrors `PtyTerminal.tsx`'s xterm.js + module-level singleton pattern, wired to `codexPty:*`. |
| `src/components/codexTerminal/CodexTerminalView.tsx` (new) | Mirrors `TerminalView.tsx`, terminal host only, no rail cards. |
| `src/viewRegistry.ts` (modify) | Add the `Codex` sidebar entry. |
| `src/components/settings/CrossEngineVerificationCard.tsx` (modify) | Add a second toggle for the Codex terminal, gating whether `CodexTerminalView` ever mounts a real pty. |
| `docs/privacy-and-data.md`, `README.md`, `docs/roadmap.md` (modify) | Second named exception; roadmap row. |

---

### Task 1: `codexPtyManager.ts` — env builder and spawn function

**Files:**
- Create: `electron/codexPtyManager.ts`, `electron/codexPtyManager.test.ts`

**Interfaces:**
- Consumes: `resolveCodexHome` from `../crossEngine/acpProcess` (already shipped,
  signature `(): string`).
- Produces: `buildCodexPtyEnv(source: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv`,
  `spawnCodexPty(cols?: number, rows?: number)` returning a `node-pty` `IPty` (same
  return shape as `ptyManager.ts`'s `spawnPty`).

- [ ] **Step 1: Write the failing tests**

```ts
// electron/codexPtyManager.test.ts
import { describe, it, expect } from 'vitest';
import { buildCodexPtyEnv } from './codexPtyManager';

// Mirrors ptyManager.test.ts's guard, for the Codex terminal's own launch path.
describe('buildCodexPtyEnv', () => {
  it('strips OPENAI_API_KEY and CODEX_API_KEY', () => {
    const source = {
      OPENAI_API_KEY: 'sk-openai-secret',
      CODEX_API_KEY: 'codex-secret',
      PATH: '/usr/bin',
    };
    const env = buildCodexPtyEnv(source, 'C:/fake/codex-home');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('does not mutate the source env object', () => {
    const source = { OPENAI_API_KEY: 'sk-openai-secret' };
    buildCodexPtyEnv(source, 'C:/fake/codex-home');
    expect(source.OPENAI_API_KEY).toBe('sk-openai-secret');
  });

  it('always sets CODEX_HOME to the dedicated directory, never the OS value', () => {
    const source = { CODEX_HOME: '/some/other/global/home' };
    const env = buildCodexPtyEnv(source, 'C:/fake/codex-home');
    expect(env.CODEX_HOME).toBe('C:/fake/codex-home');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run electron/codexPtyManager.test.ts`
Expected: FAIL — cannot resolve `./codexPtyManager`.

- [ ] **Step 3: Write the implementation**

```ts
// electron/codexPtyManager.ts
import * as pty from 'node-pty';
import os from 'node:os';
import { resolveCodexHome } from './crossEngine/acpProcess';

// The terminal ALWAYS starts a fresh codex session -- matching ptyManager.ts's
// identical decision for claude: never add resume flags.
const CODEX_LAUNCH_COMMAND = 'codex\r';

// A real interactive terminal cannot structurally prevent the operator from
// typing an API key by hand inside the session -- stripping these from the
// inherited environment closes the "silently inherited from your shell"
// path, the same category of protection ptyManager.ts's buildPtyEnv already
// gives Claude's terminal, and the same limitation it already documents:
// this reduces risk, it does not eliminate manual entry.
const API_KEY_ENV_VARS = ['OPENAI_API_KEY', 'CODEX_API_KEY'] as const;

export function buildCodexPtyEnv(source: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of API_KEY_ENV_VARS) delete env[key];
  // Dedicated, isolated home shared with the cross-engine verifier -- never
  // the operator's global ~/.codex. See electron/crossEngine/acpProcess.ts.
  env.CODEX_HOME = codexHome;
  return env;
}

export function spawnCodexPty(cols = 100, rows = 30) {
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash';
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols,
    rows,
    cwd: os.homedir(),
    env: buildCodexPtyEnv(process.env, resolveCodexHome()),
  });
  ptyProcess.write(CODEX_LAUNCH_COMMAND);
  return ptyProcess;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run electron/codexPtyManager.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc -b` (expect exit 0).

```bash
git add electron/codexPtyManager.ts electron/codexPtyManager.test.ts
git commit -m "feat(codex-terminal): add the Codex pty env builder and spawn function"
```

---

### Task 2: Wire the `codexPty:*` IPC channels in main

**Files:**
- Modify: `electron/main.ts`, `electron/preload.ts`, `src/aetherElectron.d.ts`

**Interfaces:**
- Consumes: `spawnCodexPty` (Task 1); `PtyLifecycle` from `./ptyLifecycle` (already
  shipped, unmodified — see its full current source below for the exact API this task
  calls).
- Produces: `window.aetherElectron.codexPty.{start,write,resize,onData,onAlive,onExit}`.

`PtyLifecycle`'s current shape (read `electron/ptyLifecycle.ts` yourself to confirm
nothing has changed before writing code against it):

```ts
class PtyLifecycle {
  get current(): PtyLike | null;
  start(spawn: () => PtyLike, handlers: { onData: (data: string) => void; onAlive: () => void; onExit: () => void }): PtyLike;
  write(input: string): void;
  resize(cols: number, rows: number): void;
}
```

- [ ] **Step 1: Add the second `PtyLifecycle` instance and IPC handlers**

In `electron/main.ts`, near the existing `pty:*` handlers (read that block first —
`ptyLifecycle`, `pty:start`/`pty:write`/`pty:resize` — to match its exact style):

```ts
import { spawnCodexPty } from './codexPtyManager';
// (PtyLifecycle is already imported for the Claude pty -- reuse the same import)

// Fully independent from the Claude pty's ptyLifecycle above: separate
// instance, separate channels, never shares state.
const codexPtyLifecycle = new PtyLifecycle();

ipcMain.handle('codexPty:start', (event, { cols, rows }: { cols: number; rows: number }) => {
  const sender = event.sender;
  codexPtyLifecycle.start(() => spawnCodexPty(cols, rows), {
    onData: (data) => {
      if (!sender.isDestroyed()) sender.send('codexPty:data', data);
    },
    onAlive: () => sendToWindow('codexPty:alive', undefined),
    onExit: () => sendToWindow('codexPty:exit', undefined),
  });
});

ipcMain.on('codexPty:write', (_event, input: string) => {
  codexPtyLifecycle.write(input);
});

ipcMain.on('codexPty:resize', (_event, { cols, rows }: { cols: number; rows: number }) => {
  codexPtyLifecycle.resize(cols, rows);
});
```

Note: unlike the Claude pty's `pty:start` handler, do NOT call
`liveAgentTracker.notifyPtySpawned(...)` here — that call feeds Claude-specific dispatch
tracking, out of scope per this plan's Global Constraints (no dispatch/narration
integration for the Codex terminal).

- [ ] **Step 2: Expose the channel in preload and its type declaration together**

`electron/preload.ts` — read the existing `pty:` block first and mirror it exactly:

```ts
codexPty: {
  start: (opts: { cols: number; rows: number }) => ipcRenderer.invoke('codexPty:start', opts),
  write: (input: string) => ipcRenderer.send('codexPty:write', input),
  resize: (cols: number, rows: number) => ipcRenderer.send('codexPty:resize', { cols, rows }),
  onData: (callback: (data: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: string) => callback(data);
    ipcRenderer.on('codexPty:data', listener);
    return () => ipcRenderer.removeListener('codexPty:data', listener);
  },
  onAlive: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('codexPty:alive', listener);
    return () => ipcRenderer.removeListener('codexPty:alive', listener);
  },
  onExit: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('codexPty:exit', listener);
    return () => ipcRenderer.removeListener('codexPty:exit', listener);
  },
},
```

`src/aetherElectron.d.ts`, same commit:

```ts
codexPty: {
  start: (opts: { cols: number; rows: number }) => Promise<void>;
  write: (input: string) => void;
  resize: (cols: number, rows: number) => void;
  onData: (callback: (data: string) => void) => () => void;
  onAlive: (callback: () => void) => () => void;
  onExit: (callback: () => void) => () => void;
};
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc -b`, `npm run build`, `npm run electron:build`. All exit 0.

```bash
git add electron/main.ts electron/preload.ts src/aetherElectron.d.ts
git commit -m "feat(codex-terminal): wire the codexPty IPC channels in main"
```

---

### Task 3: `codexTerminalAlive` state slice and sync hook

**Files:**
- Modify: `src/state/types.ts`, `reducer.ts`, `reducer.test.ts`, `initialState.ts`, `persistence.ts`, `App.tsx`
- Create: `src/state/useCodexTerminalAliveSync.ts`

**Interfaces:**
- Consumes: `window.aetherElectron.codexPty.{onAlive,onExit}` (Task 2).
- Produces: `state.codexTerminalAlive: boolean`, action
  `{ type: 'SET_CODEX_TERMINAL_ALIVE'; alive: boolean }`, hook `useCodexTerminalAliveSync()`.

- [ ] **Step 1: Add the state slice, action, reducer case, persistence exclusion**

`src/state/types.ts`, beside the existing `terminalAlive: boolean;`:

```ts
  codexTerminalAlive: boolean;
```

`src/state/reducer.ts`, mirroring the `SET_TERMINAL_ALIVE` action/case exactly:

```ts
  | { type: 'SET_CODEX_TERMINAL_ALIVE'; alive: boolean }
// switch:
    case 'SET_CODEX_TERMINAL_ALIVE':
      return { ...state, codexTerminalAlive: action.alive };
```

`src/state/initialState.ts`, beside `terminalAlive: false,`:

```ts
  codexTerminalAlive: false,
```

`src/state/persistence.ts`'s `PERSISTENCE_EXCLUSIONS`, beside the `terminalAlive` entry:

```ts
  codexTerminalAlive: "recomputed live -- starts false at every launch (no pty exists until the Codex view mounts) and is driven only by this session's own codexPty:alive/codexPty:exit events via useCodexTerminalAliveSync, same reasoning as terminalAlive",
```

- [ ] **Step 2: Add the reducer tests and run them**

```ts
// src/state/reducer.test.ts, beside the SET_TERMINAL_ALIVE tests
it('SET_CODEX_TERMINAL_ALIVE flips codexTerminalAlive to true (the codexPty:alive push)', () => {
  const next = reducer(initialState, { type: 'SET_CODEX_TERMINAL_ALIVE', alive: true });
  expect(next.codexTerminalAlive).toBe(true);
});

it('SET_CODEX_TERMINAL_ALIVE flips codexTerminalAlive to false (the codexPty:exit push)', () => {
  const alive = reducer(initialState, { type: 'SET_CODEX_TERMINAL_ALIVE', alive: true });
  const next = reducer(alive, { type: 'SET_CODEX_TERMINAL_ALIVE', alive: false });
  expect(next.codexTerminalAlive).toBe(false);
});

it('SET_CODEX_TERMINAL_ALIVE leaves terminalAlive (the Claude pty's own flag) untouched', () => {
  const withClaudeAlive = reducer(initialState, { type: 'SET_TERMINAL_ALIVE', alive: true });
  const next = reducer(withClaudeAlive, { type: 'SET_CODEX_TERMINAL_ALIVE', alive: true });
  expect(next.terminalAlive).toBe(true);
  expect(next.codexTerminalAlive).toBe(true);
});
```

Run: `npx vitest run src/state/reducer.test.ts src/state/persistence.test.ts`
Expected: PASS. The persistence coverage test fails if the exclusion was omitted.

- [ ] **Step 3: Add the sync hook**

```ts
// src/state/useCodexTerminalAliveSync.ts
import { useEffect } from 'react';
import { useAetherStore } from './store';

/** Mirrors useTerminalAliveSync.ts exactly, for the independent Codex pty.
 *  codexTerminalAlive starts FALSE for the same reason terminalAlive does:
 *  nothing spawns the Codex pty until CodexTerminalView actually mounts, and
 *  liveness is driven entirely by main's codexPty:alive/codexPty:exit pushes
 *  -- no mount-time pull, main re-announces codexPty:alive on every
 *  codexPty:start. */
export function useCodexTerminalAliveSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const codexPty = window.aetherElectron?.codexPty;
    if (!codexPty) return;

    const unsubscribeAlive = codexPty.onAlive(() => {
      dispatch({ type: 'SET_CODEX_TERMINAL_ALIVE', alive: true });
    });
    const unsubscribeExit = codexPty.onExit(() => {
      dispatch({ type: 'SET_CODEX_TERMINAL_ALIVE', alive: false });
    });

    return () => {
      unsubscribeAlive();
      unsubscribeExit();
    };
  }, [dispatch]);
}
```

- [ ] **Step 4: Mount it in App.tsx**

Read `src/App.tsx`'s existing `TerminalAliveSync` wrapper component first, then add the
import and an identical wrapper, mounted alongside it:

```tsx
import { useCodexTerminalAliveSync } from './state/useCodexTerminalAliveSync';
// ...
function CodexTerminalAliveSync() {
  useCodexTerminalAliveSync();
  return null;
}
```

Add `<CodexTerminalAliveSync />` beside the existing `<TerminalAliveSync />`.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc -b`, `npx vitest run`, `npm run build`. All exit 0.

```bash
git add src/state src/App.tsx
git commit -m "feat(codex-terminal): add codexTerminalAlive state and its sync hook"
```

---

### Task 4: `PtyCodexTerminal` and `CodexTerminalView` components

**Files:**
- Create: `src/components/codexTerminal/PtyCodexTerminal.tsx`, `src/components/codexTerminal/CodexTerminalView.tsx`

**Interfaces:**
- Consumes: `window.aetherElectron.codexPty.{start,write,resize,onData}` (Task 2).
- Produces: `<CodexTerminalView />` (the component `viewRegistry.ts` will reference in
  Task 5).

- [ ] **Step 1: Write `PtyCodexTerminal.tsx`**

Read `src/components/terminal/PtyTerminal.tsx` in full first — this is a close mirror,
swapping `window.aetherElectron.pty` for `window.aetherElectron.codexPty` and using its
own independent module-level singleton (never share `sharedHostEl`/`sharedTerm`/`sharedFit`
with Claude's terminal):

```tsx
// src/components/codexTerminal/PtyCodexTerminal.tsx
import { useEffect, useRef, type CSSProperties } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { colors as darkColors, fonts } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import '@xterm/xterm/css/xterm.css';

// Module-level, independent from Claude terminal's own singleton in
// PtyTerminal.tsx -- the real codex session survives PtyCodexTerminal being
// unmounted/remounted every time the operator switches away from the Codex
// tab and back, same reasoning as PtyTerminal.tsx's identical pattern.
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
      theme: { background: darkColors.bgTerminal, foreground: darkColors.textBody },
    });
    sharedFit = new FitAddon();
    sharedTerm.loadAddon(sharedFit);
    sharedTerm.open(sharedHostEl);

    const codexPty = window.aetherElectron!.codexPty;
    codexPty.start({ cols: sharedTerm.cols, rows: sharedTerm.rows }); // only ever called once per app lifetime
    codexPty.onData((data) => sharedTerm!.write(data));
    sharedTerm.onData((input) => codexPty.write(input));
    sharedTerm.onResize(({ cols, rows }) => codexPty.resize(cols, rows));
  }
  return { hostEl: sharedHostEl, fit: sharedFit! };
}

export function PtyCodexTerminal() {
  const colors = useColors();
  const anchorRef = useRef<HTMLDivElement>(null);
  const hasElectronCodexPty = typeof window !== 'undefined' && !!window.aetherElectron?.codexPty;

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || !hasElectronCodexPty) return;

    const { hostEl, fit } = getOrCreateHost();
    anchor.appendChild(hostEl);
    fit.fit();

    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(anchor);

    return () => {
      resizeObserver.disconnect();
      hostEl.remove();
    };
  }, [hasElectronCodexPty]);

  useEffect(() => {
    if (!sharedTerm) return;
    sharedTerm.options.theme = { background: colors.bgTerminal, foreground: colors.textBody };
  }, [colors]);

  if (!hasElectronCodexPty) {
    return <div style={fallbackStyle}>Codex terminal requires the Electron app — run `npm run electron:dev`</div>;
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
  color: darkColors.textDim,
  textAlign: 'center',
  padding: 20,
};
```

- [ ] **Step 2: Write `CodexTerminalView.tsx`**

Read `src/components/terminal/TerminalView.tsx` first. Mirror its card chrome, but with
NO rail (`SystemOverviewCard`/`ActiveAgentsCard`/`LiveOutputCard` are Claude-dispatch-
specific, out of scope per this plan's Global Constraints):

```tsx
// src/components/codexTerminal/CodexTerminalView.tsx
import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { PtyCodexTerminal } from './PtyCodexTerminal';

export function CodexTerminalView() {
  const colors = useColors();
  return (
    <div style={rootStyle}>
      <div style={terminalCardStyle(colors)}>
        <div style={headerStyle(colors)}>
          <span style={liveDotStyle(colors)} />
          <span style={{ font: `400 13px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>operator@codex</span>
          <span style={{ font: `400 13px/1 ${fonts.mono}`, color: colors.textDim }}>:~$ session active</span>
          <span style={{ marginLeft: 'auto', font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>CODEX TERMINAL</span>
        </div>
        <div style={termHostStyle}>
          <PtyCodexTerminal />
        </div>
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex' };
function terminalCardStyle(colors: ColorPalette): CSSProperties {
  return {
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
}
function headerStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '11px 16px',
    borderBottom: `1px solid ${colors.chromeBorder}`,
  };
}
function liveDotStyle(colors: ColorPalette): CSSProperties {
  return { width: 10, height: 10, borderRadius: '50%', background: colors.accentCyanDeep, boxShadow: '0 0 8px rgba(95,240,255,.8)' };
}
const termHostStyle: CSSProperties = { flex: 1, minHeight: 0, position: 'relative' };
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc -b`, `npm run build`. Both exit 0. (No unit tests for this task — matching
`PtyTerminal.tsx`/`TerminalView.tsx`'s own precedent of no dedicated test file, since
both wrap a real xterm.js/pty integration that's exercised via `electron:dev`, not
vitest's jsdom environment.)

```bash
git add src/components/codexTerminal
git commit -m "feat(codex-terminal): add the PtyCodexTerminal and CodexTerminalView components"
```

---

### Task 5: Sidebar entry and settings toggle

**Files:**
- Modify: `src/viewRegistry.ts`, `src/viewRegistry.test.ts`, `src/components/settings/CrossEngineVerificationCard.tsx`, `src/components/settings/CrossEngineVerificationCard.test.tsx`

**Interfaces:**
- Consumes: `CodexTerminalView` (Task 4).
- Produces: sidebar entry `Codex`; a `codexTerminalCfg: { enabled: boolean }` field on
  `AetherState` (default-off) gating whether `CodexTerminalView` actually mounts a real
  pty.

- [ ] **Step 1: Add the sidebar entry**

`src/viewRegistry.ts` — read the current `VIEWS` array first (it's a flat sidebar-only
list, no `inTopBar` field per the earlier navigation cleanup), then add:

```ts
import { CodexTerminalView } from './components/codexTerminal/CodexTerminalView';
// ...
  { id: 'Codex', inSidebar: true, component: CodexTerminalView },
```

Place it near `'Terminal'` in the array (sidebar order follows array order).

- [ ] **Step 2: Update the viewRegistry test**

`src/viewRegistry.test.ts` — read its current `sidebarIds` assertion and add `'Codex'`
in the position matching where you placed it in Step 1. Also add:

```ts
it('getViewComponent resolves Codex now that it is built', () => {
  expect(getViewComponent('Codex')).not.toBeNull();
});
```

- [ ] **Step 3: Add the default-off toggle to the state**

Read `src/state/types.ts`'s existing `crossEngineCfg: { enabled: boolean; provider: string };`
field for the pattern to match, then add beside it:

```ts
  codexTerminalCfg: { enabled: boolean };
```

`src/state/reducer.ts`, mirroring `SET_CROSS_ENGINE_CFG` exactly:

```ts
  | { type: 'SET_CODEX_TERMINAL_CFG'; cfg: { enabled: boolean } }
// switch:
    case 'SET_CODEX_TERMINAL_CFG':
      return { ...state, codexTerminalCfg: action.cfg };
```

`src/state/initialState.ts`:

```ts
  codexTerminalCfg: { enabled: false },
```

`src/state/persistence.ts`: `codexTerminalCfg` is persisted (user intent, like
`crossEngineCfg`) — add it to the persisted whitelist, not the exclusions list.

- [ ] **Step 4: Add the reducer/persistence tests and run them**

```ts
// src/state/reducer.test.ts
it('SET_CODEX_TERMINAL_CFG replaces codexTerminalCfg wholesale', () => {
  const cfg = { enabled: true };
  const next = reducer(initialState, { type: 'SET_CODEX_TERMINAL_CFG', cfg });
  expect(next.codexTerminalCfg).toEqual(cfg);
});
```

Run: `npx vitest run src/state/reducer.test.ts src/state/persistence.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the toggle to `CrossEngineVerificationCard.tsx`, and gate the pty on it**

Read the current file in full first (it already has an `enabled`/`confirming`/toggle
pattern for the verifier's own `crossEngineCfg` — mirror that exact style for a second,
visually distinct toggle in the same card, per the design spec's placement decision).
Add a second section below the existing verifier controls:

```tsx
<div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${colors.chipBorder}` }}>
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
    <div style={titleStyle(colors)}>CODEX TERMINAL</div>
    <Button
      onClick={() => dispatch({ type: 'SET_CODEX_TERMINAL_CFG', cfg: { enabled: !state.codexTerminalCfg.enabled } })}
      style={toggleStyle(colors, state.codexTerminalCfg.enabled)}
    >
      {state.codexTerminalCfg.enabled ? 'DISABLE' : 'ENABLE'}
    </Button>
  </div>
  <p style={hintStyle(colors)}>
    A real, interactive Codex session with the same file/command access Claude's terminal already has.
    Uses the same ChatGPT connection as verification above. Typing an API key into the session
    yourself is not something this app can prevent.
  </p>
</div>
```

(Reuse this file's existing `titleStyle`/`toggleStyle`/`hintStyle` helpers unchanged —
do not invent new style functions for this section.)

`CodexTerminalView` (Task 4) must check `state.codexTerminalCfg.enabled` before
rendering `<PtyCodexTerminal />` — if disabled, render a short explanatory message
instead (mirroring the "requires the Electron app" fallback style already in
`PtyCodexTerminal.tsx`), so a disabled feature never spawns a pty even if the operator
navigates to the Codex tab. Update `CodexTerminalView.tsx` from Task 4:

```tsx
import { useAetherStore } from '../../state/store';
// ...
export function CodexTerminalView() {
  const colors = useColors();
  const { state } = useAetherStore();
  if (!state.codexTerminalCfg.enabled) {
    return (
      <div style={rootStyle}>
        <div style={disabledCardStyle(colors)}>Codex terminal is disabled — enable it in Settings first.</div>
      </div>
    );
  }
  // ...existing card markup...
}
```

(Add a small `disabledCardStyle` helper matching this file's existing style-function
convention.)

- [ ] **Step 6: Write and run the settings card test**

```tsx
// src/components/settings/CrossEngineVerificationCard.test.tsx
it('Codex terminal toggle defaults off and flips SET_CODEX_TERMINAL_CFG on click', () => {
  render(
    <AetherStoreProvider>
      <CrossEngineVerificationCard />
    </AetherStoreProvider>,
  );
  const codexSection = screen.getByText('CODEX TERMINAL').closest('div')!;
  expect(within(codexSection.parentElement!).getByText('ENABLE')).toBeTruthy();
});
```

(Adjust the query to this file's existing test conventions — check how the file's other
tests locate a specific toggle button when the card renders more than one, and match
that pattern rather than introducing a new query style.)

Run: `npx vitest run src/components/settings/CrossEngineVerificationCard.test.tsx`
Expected: PASS.

- [ ] **Step 7: Verify and commit**

Run: `npx tsc -b`, `npx vitest run`, `npm run build`, `npm run electron:build`. All exit 0.

```bash
git add src/viewRegistry.ts src/viewRegistry.test.ts src/state src/components/settings src/components/codexTerminal
git commit -m "feat(codex-terminal): add the sidebar entry and default-off settings toggle"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/privacy-and-data.md`, `README.md`, `docs/roadmap.md`

- [ ] **Step 1: Amend `docs/privacy-and-data.md`**

Add a second named exception, alongside the existing cross-engine verifier section.
State plainly: this session has the same open-ended file/command access Claude's
terminal already has; it is gated behind its own default-off toggle; it shares the
verifier's dedicated `CODEX_HOME` and env-stripping; the app cannot prevent the operator
from typing an API key by hand inside the session, and this limitation is named rather
than glossed over.

- [ ] **Step 2: Correct `README.md`**

Update the feature list to mention the Codex terminal alongside the existing verifier
entry, using the same precise, non-overclaiming language style already established
there for the verifier.

- [ ] **Step 3: Add the roadmap row**

`docs/roadmap.md` — follow the established table row format for a shipped stage
(check the most recent row for exact formatting), naming that this is a second,
independent Codex surface alongside the existing one-shot verifier, and that it carries
no cost/token tracking in this version.

- [ ] **Step 4: Commit**

```bash
git add docs/privacy-and-data.md README.md docs/roadmap.md
git commit -m "docs(codex-terminal): document the Codex terminal privacy boundary"
```

---

After all six tasks: whole-branch review. Three questions the reviewer must answer
explicitly:

1. **Does `codexPty:*` ever share state with `pty:*`?** Read both `PtyLifecycle`
   instances in `main.ts` and confirm they're genuinely independent — one Claude pty
   dying or respawning must never affect the Codex pty's own liveness tracking, and
   vice versa.
2. **Can the Codex pty ever spawn while `codexTerminalCfg.enabled` is false?** Trace
   every path that could mount `PtyCodexTerminal` (not just the normal sidebar
   navigation) and confirm the disabled-state check in `CodexTerminalView` is the only
   gate, and that it actually prevents `getOrCreateHost()` from ever running.
3. **Does `docs/privacy-and-data.md`'s new section accurately name the
   manual-API-key-entry limitation**, or does it overclaim protection this feature does
   not actually provide?
