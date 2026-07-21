# Real Active Agents (Phase 3, first slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Terminal's `ActiveAgentsCard` and Dashboard's `ActiveAgentsDigest` with real data about currently-open Claude Code `Agent`-tool dispatches, live-tailed from whichever session is globally most-recently-active.

**Architecture:** A pure, fully-tested dispatch-tracking function (`applyLinesToOpenDispatches`) lives under `src/state/` so both Vitest and the main process can use it. Main-process code (ported session-finder + byte-offset tailer, plus a new stateful tracker built on the pure function) re-checks the active session every tick and pushes the current open-dispatch set over a new `agents:snapshot` IPC channel. The renderer gets a `state.realAgents` slice fed by a new `useRealAgentsSync()` hook (mirroring the existing `useRealUsageSync()` pattern), and the two target cards are rewritten to read it instead of the fictional `state.agents` roster.

**Tech Stack:** TypeScript, React 18, Vitest, Node `fs.promises`, Electron IPC (`contextBridge`/`ipcRenderer`/`ipcMain`).

## Global Constraints

- Real subagent-dispatch tool name is `"Agent"` (a `tool_use` block with `name === 'Agent'`) — not `"Task"`.
- The reliable completion signal is a `type:"user"` message with `"origin":{"kind":"task-notification"}` whose `message.content` string contains `<tool-use-id>...</tool-use-id>`. Do **not** use `type:"queue-operation"` events as a completion signal — confirmed unreliable (only ~7% of `enqueue` events are genuine task-notifications).
- On every tick, re-run session discovery from scratch (fixes TokenMonitor's "only picks the active session once at startup" bug) — never cache "the" active file across the app's lifetime.
- Whenever the active file changes (including the very first tick), replay the **entire** file from byte 0 through the pure tracking function before switching to incremental byte-offset tailing. Never skip to "current end of file" on a switch.
- `ActiveAgentsCard.tsx` loses its "SPAWN +" button; `ActiveAgentsDigest.tsx` loses its "VIEW ALL →" link. Neither card keeps an `onClick`/navigation affordance in this slice.
- No per-dispatch token/duration history, no "recently completed" list, no kill/interact actions — a dispatch simply disappears from `state.realAgents` once its completion event is seen.
- Only these two components change their read source (`state.agents` → `state.realAgents`); Grid, Analytics, Files, Memory, Chat, and the Agents view are untouched.
- `electron/*.ts` files are not covered by Vitest (`vitest run` has no matching `*.test.ts` there) and are not covered by the root `tsc -b` — this project's established pattern for ported, main-process-only code (see `historyScanner.ts`, `transcriptParser.ts`). New `electron/` files in this plan follow the same convention: no unit tests, verified only by `electron:build`/`electron:dev` manual checks.
- Baseline before this plan: all `npm test` tests passing, clean `tsc -b`, clean `electron:build`, working tree clean at commit `47bc5f9` (the Phase 3 spec commit).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/state/liveAgentsMath.ts` (new) | Pure `RealAgentDispatch` type + `applyLinesToOpenDispatches(currentOpen, rawLines)` — the only place dispatch-tracking logic lives. Fully unit-tested. |
| `src/state/liveAgentsMath.test.ts` (new) | Vitest coverage for the pure function. |
| `electron/activeSessionFinder.ts` (new) | Port of TokenMonitor's `src/main/activeSessionFinder.js`: `findMostRecentSessionFile(projectsRoot)`. |
| `electron/transcriptTailer.ts` (new) | Port of TokenMonitor's `src/main/transcriptTailer.js`: `readNewLines(filePath, offset)`. |
| `electron/liveAgentTracker.ts` (new) | New orchestration: `createLiveAgentTracker(projectsRoot)` → `{ tick(): Promise<RealAgentDispatch[]> }`, using the two files above plus the pure function from `src/state/liveAgentsMath.ts`. |
| `electron/main.ts` (modify) | New 1s `setInterval` calling the tracker's `tick()` and pushing `agents:snapshot`. |
| `electron/preload.ts` (modify) | New `agents.onSnapshot(callback)` bridge method. |
| `src/aetherElectron.d.ts` (modify) | Type the new `agents` bridge surface. |
| `src/state/types.ts` (modify) | Add `realAgents: RealAgentDispatch[]` to `AetherState` (re-exporting `RealAgentDispatch` from `liveAgentsMath.ts`). |
| `src/state/initialState.ts` (modify) | Seed `realAgents: []`. |
| `src/state/reducer.ts` (modify) | New `SET_REAL_AGENTS` action + case. |
| `src/state/useRealAgentsSync.ts` (new) | Hook mirroring `useRealUsageSync.ts`, dispatching `SET_REAL_AGENTS` on each snapshot. |
| `src/App.tsx` (modify) | Mount a `RealAgentsSync` component alongside `RealUsageSync`. |
| `src/utils/format.ts` (modify) | New `fmtElapsed(ms)` helper. |
| `src/components/terminal/ActiveAgentsCard.tsx` (rewrite) | Reads `state.realAgents`; drops SPAWN+, pct bar, per-agent hue, onClick. |
| `src/components/dashboard/ActiveAgentsDigest.tsx` (rewrite) | Reads `state.realAgents`; drops VIEW ALL, pct bar, per-agent hue, onClick. |

---

### Task 1: Pure dispatch-tracking logic (`liveAgentsMath.ts`)

**Files:**
- Create: `src/state/liveAgentsMath.ts`
- Test: `src/state/liveAgentsMath.test.ts`

**Interfaces:**
- Produces: `export interface RealAgentDispatch { toolUseId: string; subagentType: string; description: string; startedAt: string }` and `export function applyLinesToOpenDispatches(currentOpen: RealAgentDispatch[], rawLines: string[]): RealAgentDispatch[]`. Every later task that needs this type imports it from `src/state/liveAgentsMath.ts` (not redefined anywhere else).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/state/liveAgentsMath.test.ts
import { describe, expect, it } from 'vitest';
import { applyLinesToOpenDispatches, type RealAgentDispatch } from './liveAgentsMath';

function dispatchLine(id: string, subagentType: string, description: string, timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: subagentType, description } }],
    },
  });
}

function completionLine(toolUseId: string, status = 'completed'): string {
  return JSON.stringify({
    type: 'user',
    origin: { kind: 'task-notification' },
    message: {
      content: `<task-notification><task-id>t1</task-id><tool-use-id>${toolUseId}</tool-use-id><status>${status}</status><summary>done</summary></task-notification>`,
    },
  });
}

describe('applyLinesToOpenDispatches', () => {
  it('adds an open dispatch from an Agent tool_use line', () => {
    const lines = [dispatchLine('tu_1', 'general-purpose', 'Explore the repo', '2026-07-20T10:00:00.000Z')];
    const result = applyLinesToOpenDispatches([], lines);
    expect(result).toEqual<RealAgentDispatch[]>([
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'Explore the repo', startedAt: '2026-07-20T10:00:00.000Z' },
    ]);
  });

  it('removes a dispatch on a matching real task-notification completion', () => {
    const lines = [dispatchLine('tu_1', 'general-purpose', 'Explore the repo', '2026-07-20T10:00:00.000Z'), completionLine('tu_1')];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([]);
  });

  it('removes a dispatch whose completion has status failed or killed, not just completed', () => {
    const lines = [dispatchLine('tu_1', 'general-purpose', 'desc', '2026-07-20T10:00:00.000Z'), completionLine('tu_1', 'failed')];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([]);
  });

  it('ignores queue-operation lines even when their content contains task-notification-shaped XML', () => {
    const queueLine = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: '<task-notification><task-id>t1</task-id><tool-use-id>tu_1</tool-use-id><status>completed</status></task-notification>',
    });
    const lines = [dispatchLine('tu_1', 'general-purpose', 'desc', '2026-07-20T10:00:00.000Z'), queueLine];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'desc', startedAt: '2026-07-20T10:00:00.000Z' },
    ]);
  });

  it('does not treat an ordinary user message without origin.kind as a completion signal', () => {
    const plainUserLine = JSON.stringify({ type: 'user', message: { content: 'just a normal reply' } });
    const lines = [dispatchLine('tu_1', 'general-purpose', 'desc', '2026-07-20T10:00:00.000Z'), plainUserLine];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'desc', startedAt: '2026-07-20T10:00:00.000Z' },
    ]);
  });

  it('ignores tool_use blocks with a name other than Agent', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-20T10:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/x' } }] },
    });
    expect(applyLinesToOpenDispatches([], [line])).toEqual([]);
  });

  it('leaves other open dispatches alone when only one of several completes', () => {
    const lines = [
      dispatchLine('tu_1', 'general-purpose', 'first', '2026-07-20T10:00:00.000Z'),
      dispatchLine('tu_2', 'Explore', 'second', '2026-07-20T10:00:05.000Z'),
      completionLine('tu_1'),
    ];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([
      { toolUseId: 'tu_2', subagentType: 'Explore', description: 'second', startedAt: '2026-07-20T10:00:05.000Z' },
    ]);
  });

  it('is a safe no-op for a completion event whose tool-use-id is not currently open', () => {
    expect(applyLinesToOpenDispatches([], [completionLine('unknown_id')])).toEqual([]);
  });

  it('skips malformed JSON lines without throwing', () => {
    expect(() => applyLinesToOpenDispatches([], ['not json', '', '   '])).not.toThrow();
    expect(applyLinesToOpenDispatches([], ['not json', '', '   '])).toEqual([]);
  });

  it('continues from a non-empty currentOpen list (incremental tailing)', () => {
    const priorOpen: RealAgentDispatch[] = [{ toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'first', startedAt: '2026-07-20T10:00:00.000Z' }];
    const result = applyLinesToOpenDispatches(priorOpen, [completionLine('tu_1')]);
    expect(result).toEqual([]);
  });

  it('defaults subagentType and description when input fields are missing', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-20T10:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Agent', input: {} }] },
    });
    expect(applyLinesToOpenDispatches([], [line])).toEqual([
      { toolUseId: 'tu_1', subagentType: 'agent', description: '', startedAt: '2026-07-20T10:00:00.000Z' },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/state/liveAgentsMath.test.ts`
Expected: FAIL — `Cannot find module './liveAgentsMath'` (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

```typescript
// src/state/liveAgentsMath.ts
export interface RealAgentDispatch {
  toolUseId: string;
  subagentType: string;
  description: string;
  startedAt: string;
}

export function applyLinesToOpenDispatches(currentOpen: RealAgentDispatch[], rawLines: string[]): RealAgentDispatch[] {
  const open = new Map(currentOpen.map((d) => [d.toolUseId, d]));

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let json: any;
    try {
      json = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (json.type === 'assistant' && json.message) {
      const content = Array.isArray(json.message.content) ? json.message.content : [];
      for (const item of content) {
        if (item && item.type === 'tool_use' && item.name === 'Agent') {
          open.set(item.id, {
            toolUseId: item.id,
            subagentType: (item.input && item.input.subagent_type) || 'agent',
            description: (item.input && item.input.description) || '',
            startedAt: json.timestamp || new Date(0).toISOString(),
          });
        }
      }
      continue;
    }

    if (json.type === 'user' && json.origin && json.origin.kind === 'task-notification') {
      const content = typeof json.message?.content === 'string' ? json.message.content : '';
      const match = content.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
      if (match) open.delete(match[1]);
    }
  }

  return [...open.values()];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/state/liveAgentsMath.test.ts`
Expected: PASS — all 11 tests green.

- [ ] **Step 5: Run the full suite and type checker**

Run: `npm test && npx tsc -b --noEmit`
Expected: all existing tests plus the 11 new ones pass; `tsc -b` clean.

- [ ] **Step 6: Commit**

```bash
git add src/state/liveAgentsMath.ts src/state/liveAgentsMath.test.ts
git commit -m "feat: add pure dispatch-tracking logic for real Active Agents"
```

---

### Task 2: Main-process live-tailing pipeline

**Files:**
- Create: `electron/activeSessionFinder.ts`
- Create: `electron/transcriptTailer.ts`
- Create: `electron/liveAgentTracker.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/aetherElectron.d.ts`

**Interfaces:**
- Consumes: `RealAgentDispatch`, `applyLinesToOpenDispatches` from `src/state/liveAgentsMath.ts` (Task 1).
- Produces: `findMostRecentSessionFile(projectsRoot: string): Promise<string | null>` (`activeSessionFinder.ts`); `readNewLines(filePath: string, offset: number): Promise<{ lines: string[]; newOffset: number }>` (`transcriptTailer.ts`); `createLiveAgentTracker(projectsRoot: string): { tick(): Promise<RealAgentDispatch[]> }` (`liveAgentTracker.ts`); IPC channel `'agents:snapshot'` carrying `RealAgentDispatch[]`; `window.aetherElectron.agents.onSnapshot(callback: (dispatches: RealAgentDispatch[]) => void): () => void`.

This task is not covered by Vitest or `tsc -b` (established convention for `electron/*.ts`, matching `historyScanner.ts`/`transcriptParser.ts`) — verification is `electron:build` succeeding and a manual run.

- [ ] **Step 1: Create the session finder**

```typescript
// electron/activeSessionFinder.ts
import { promises as fsp } from 'fs';
import path from 'path';

async function findActiveSessionFileInDir(dirPath: string): Promise<{ file: string; mtimeMs: number } | null> {
  let files: string[];
  try {
    files = (await fsp.readdir(dirPath)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  let best: { file: string; mtimeMs: number } | null = null;
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stat = await fsp.stat(filePath);
    if (!best || stat.mtimeMs > best.mtimeMs) best = { file: filePath, mtimeMs: stat.mtimeMs };
  }
  return best;
}

export async function findMostRecentSessionFile(projectsRoot: string): Promise<string | null> {
  let projectDirs;
  try {
    projectDirs = await fsp.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { file: string; mtimeMs: number } | null = null;
  for (const dirEntry of projectDirs) {
    if (!dirEntry.isDirectory()) continue;
    const candidate = await findActiveSessionFileInDir(path.join(projectsRoot, dirEntry.name));
    if (candidate && (!best || candidate.mtimeMs > best.mtimeMs)) best = candidate;
  }
  return best ? best.file : null;
}
```

- [ ] **Step 2: Create the byte-offset tailer**

```typescript
// electron/transcriptTailer.ts
import { promises as fsp } from 'fs';

export async function readNewLines(filePath: string, offset: number): Promise<{ lines: string[]; newOffset: number }> {
  const stat = await fsp.stat(filePath);
  if (stat.size <= offset) return { lines: [], newOffset: offset };

  const length = stat.size - offset;
  const fd = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await fd.read(buffer, 0, length, offset);
    const text = buffer.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) return { lines: [], newOffset: offset };
    const complete = text.slice(0, lastNewline);
    const newOffset = offset + Buffer.byteLength(complete, 'utf8') + 1;
    const lines = complete.split('\n');
    return { lines, newOffset };
  } finally {
    await fd.close();
  }
}
```

- [ ] **Step 3: Create the tracker**

```typescript
// electron/liveAgentTracker.ts
import { findMostRecentSessionFile } from './activeSessionFinder';
import { readNewLines } from './transcriptTailer';
import { applyLinesToOpenDispatches, type RealAgentDispatch } from '../src/state/liveAgentsMath';

export function createLiveAgentTracker(projectsRoot: string) {
  let currentFile: string | null = null;
  let currentOffset = 0;
  let currentOpen: RealAgentDispatch[] = [];

  return {
    async tick(): Promise<RealAgentDispatch[]> {
      const activeFile = await findMostRecentSessionFile(projectsRoot);

      if (activeFile !== currentFile) {
        currentFile = activeFile;
        currentOffset = 0;
        currentOpen = [];
        if (!activeFile) return currentOpen;
        const { lines, newOffset } = await readNewLines(activeFile, 0);
        currentOffset = newOffset;
        currentOpen = applyLinesToOpenDispatches(currentOpen, lines);
        return currentOpen;
      }

      if (!currentFile) return currentOpen;
      const { lines, newOffset } = await readNewLines(currentFile, currentOffset);
      if (lines.length === 0) return currentOpen;
      currentOffset = newOffset;
      currentOpen = applyLinesToOpenDispatches(currentOpen, lines);
      return currentOpen;
    },
  };
}
```

- [ ] **Step 4: Wire the tracker into `main.ts`**

Modify `electron/main.ts`. Add the import alongside the existing ones (after the `computeWeeklyTokens...` import line):

```typescript
import { createLiveAgentTracker } from './liveAgentTracker';
```

Add a constant near `USAGE_SCAN_INTERVAL_MS`:

```typescript
const AGENT_TICK_INTERVAL_MS = 1000;
```

Add the tracker instance and its push function near `scanAndPushUsage`:

```typescript
const liveAgentTracker = createLiveAgentTracker(join(os.homedir(), '.claude', 'projects'));

async function tickAndPushAgents(): Promise<void> {
  if (!mainWindow) return;
  const dispatches = await liveAgentTracker.tick();
  mainWindow.webContents.send('agents:snapshot', dispatches);
}
```

In the `app.whenReady().then(() => { ... })` block, alongside the existing `scanAndPushUsage(); setInterval(scanAndPushUsage, USAGE_SCAN_INTERVAL_MS);` lines, add:

```typescript
  tickAndPushAgents();
  setInterval(tickAndPushAgents, AGENT_TICK_INTERVAL_MS);
```

- [ ] **Step 5: Expose the bridge in `preload.ts`**

Modify `electron/preload.ts`. Add the import:

```typescript
import type { RealAgentDispatch } from '../src/state/liveAgentsMath';
```

Add a new top-level key alongside `pty` and `usage` inside the `contextBridge.exposeInMainWorld('aetherElectron', { ... })` object:

```typescript
  agents: {
    onSnapshot: (callback: (dispatches: RealAgentDispatch[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, dispatches: RealAgentDispatch[]) => callback(dispatches);
      ipcRenderer.on('agents:snapshot', listener);
      return () => ipcRenderer.removeListener('agents:snapshot', listener);
    },
  },
```

- [ ] **Step 6: Type the bridge in `src/aetherElectron.d.ts`**

Modify `src/aetherElectron.d.ts`. Add the import:

```typescript
import type { RealAgentDispatch } from './state/liveAgentsMath';
```

Add a new key inside the `aetherElectron?: { ... }` interface, alongside `pty` and `usage`:

```typescript
      agents: {
        onSnapshot: (callback: (dispatches: RealAgentDispatch[]) => void) => () => void;
      };
```

- [ ] **Step 7: Verify the Electron build**

Run: `npm run electron:build`
Expected: builds cleanly, no TypeScript errors in the `electron/` tsconfig, no bundler errors from the `../src/state/liveAgentsMath` cross-boundary import (mirrors Phase 2's already-verified `electron/main.ts` → `src/components/dashboard/realUsageMath` import pattern).

- [ ] **Step 8: Commit**

```bash
git add electron/activeSessionFinder.ts electron/transcriptTailer.ts electron/liveAgentTracker.ts electron/main.ts electron/preload.ts src/aetherElectron.d.ts
git commit -m "feat: add live-tailing pipeline for real Active Agent dispatches"
```

---

### Task 3: Renderer state wiring (`realAgents` slice + sync hook)

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/reducer.ts`
- Create: `src/state/useRealAgentsSync.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `RealAgentDispatch` from `src/state/liveAgentsMath.ts` (Task 1); `window.aetherElectron.agents.onSnapshot` from `src/aetherElectron.d.ts` (Task 2).
- Produces: `AetherState.realAgents: RealAgentDispatch[]`; action `{ type: 'SET_REAL_AGENTS'; agents: RealAgentDispatch[] }`; `useRealAgentsSync(): void` hook. Tasks 4 and 5 (the two card rewrites) read `state.realAgents` via `useAetherStore()`.

- [ ] **Step 1: Add the type field**

Modify `src/state/types.ts`. Add this import at the top of the file:

```typescript
import type { RealAgentDispatch } from './liveAgentsMath';
```

Add `realAgents: RealAgentDispatch[];` to the `AetherState` interface, immediately after the existing `realUsage: RealUsageSnapshot;` line:

```typescript
  realUsage: RealUsageSnapshot;
  realAgents: RealAgentDispatch[];
```

- [ ] **Step 2: Seed the initial state**

Modify `src/state/initialState.ts`. Add `realAgents: [],` immediately after the existing `realUsage: { ... },` line (the last field before the closing `};`):

```typescript
  realUsage: { weeklyTokens: [0, 0, 0, 0, 0, 0, 0], usedThisMonth: 0, burnRatePerMin: 0, weekOverWeekPct: null, lastScanAt: null },
  realAgents: [],
};
```

- [ ] **Step 3: Add the reducer action**

Modify `src/state/reducer.ts`. Add the import at the top, alongside the existing `RealUsageSnapshot` import:

```typescript
import type { Approval, AetherState, Cfg, MemoryStub, OpMode, RealUsageSnapshot } from './types';
import type { RealAgentDispatch } from './liveAgentsMath';
```

Add a new member to the `Action` union, immediately after `| { type: 'SET_REAL_USAGE'; snapshot: RealUsageSnapshot };`:

```typescript
  | { type: 'SET_REAL_USAGE'; snapshot: RealUsageSnapshot }
  | { type: 'SET_REAL_AGENTS'; agents: RealAgentDispatch[] };
```

Add a new case in the `reducer` function's switch statement, immediately after the existing `case 'SET_REAL_USAGE':` case:

```typescript
    case 'SET_REAL_USAGE':
      return { ...state, realUsage: action.snapshot };

    case 'SET_REAL_AGENTS':
      return { ...state, realAgents: action.agents };
```

- [ ] **Step 4: Add the sync hook**

```typescript
// src/state/useRealAgentsSync.ts
import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useRealAgentsSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const agents = window.aetherElectron?.agents;
    if (!agents) return;
    return agents.onSnapshot((dispatches) => {
      dispatch({ type: 'SET_REAL_AGENTS', agents: dispatches });
    });
  }, [dispatch]);
}
```

- [ ] **Step 5: Mount it in `App.tsx`**

Modify `src/App.tsx`. Add the import alongside the existing `useRealUsageSync` import:

```typescript
import { useRealUsageSync } from './components/dashboard/useRealUsageSync';
import { useRealAgentsSync } from './state/useRealAgentsSync';
```

Add `<RealAgentsSync />` alongside `<RealUsageSync />` inside the `<AppShell>`:

```tsx
      <AppShell>
        <PulseDurationSync />
        <RealUsageSync />
        <RealAgentsSync />
        <ActiveView />
        <BottomMetricsRow />
      </AppShell>
```

Add the component definition alongside the existing `RealUsageSync` function:

```tsx
function RealAgentsSync() {
  useRealAgentsSync();
  return null;
}
```

- [ ] **Step 6: Run the full suite and type checker**

Run: `npm test && npx tsc -b --noEmit`
Expected: all tests pass (no new test files in this task — `types.ts`/`initialState.ts`/`reducer.ts`/`useRealAgentsSync.ts`/`App.tsx` are wiring with no new pure logic to unit-test); `tsc -b` clean.

- [ ] **Step 7: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/reducer.ts src/state/useRealAgentsSync.ts src/App.tsx
git commit -m "feat: add realAgents state slice and sync hook"
```

---

### Task 4: `fmtElapsed` formatting helper

**Files:**
- Modify: `src/utils/format.ts`
- Test: `src/utils/format.test.ts` (create if it does not already exist; if it exists, add to it)

**Interfaces:**
- Produces: `export function fmtElapsed(ms: number): string`. Tasks 5 and 6 (the two card rewrites) import this from `src/utils/format.ts`.

- [ ] **Step 1: Check for an existing format test file**

Run: `ls src/utils/format.test.ts 2>/dev/null; echo done`

If it exists, read it before proceeding so the new tests are appended in the same style rather than duplicating a `describe` block. If it doesn't exist, create it fresh as shown in Step 2.

- [ ] **Step 2: Write the failing tests**

```typescript
// src/utils/format.test.ts (add this describe block; create the file with this content if it doesn't exist yet)
import { describe, expect, it } from 'vitest';
import { fmtElapsed } from './format';

describe('fmtElapsed', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(fmtElapsed(45_000)).toBe('45s');
  });

  it('formats minute-scale durations as minutes and seconds', () => {
    expect(fmtElapsed(2 * 60_000 + 14_000)).toBe('2m 14s');
  });

  it('formats hour-scale durations as hours and minutes', () => {
    expect(fmtElapsed(90 * 60_000)).toBe('1h 30m');
  });

  it('returns 0s for zero or negative elapsed time', () => {
    expect(fmtElapsed(0)).toBe('0s');
    expect(fmtElapsed(-500)).toBe('0s');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- src/utils/format.test.ts`
Expected: FAIL — `fmtElapsed is not exported` (or similar, depending on whether the file already existed).

- [ ] **Step 4: Implement `fmtElapsed`**

Add this function to `src/utils/format.ts`, alongside the existing `fmtEta`:

```typescript
export function fmtElapsed(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- src/utils/format.test.ts`
Expected: PASS — all 4 new tests green (plus any pre-existing tests in the file, if it already existed).

- [ ] **Step 6: Run the full suite and type checker**

Run: `npm test && npx tsc -b --noEmit`
Expected: all tests pass; `tsc -b` clean.

- [ ] **Step 7: Commit**

```bash
git add src/utils/format.ts src/utils/format.test.ts
git commit -m "feat: add fmtElapsed formatting helper"
```

---

### Task 5: Rewrite `ActiveAgentsCard.tsx` (Terminal)

**Files:**
- Modify: `src/components/terminal/ActiveAgentsCard.tsx`

**Interfaces:**
- Consumes: `state.realAgents: RealAgentDispatch[]` (Task 3); `fmtElapsed` from `src/utils/format.ts` (Task 4); `colors`/`fonts` from `../../styles/tokens` (existing).

This task has no new pure logic — it is a component rewrite, verified by the existing project convention of manual GUI verification for presentational components (see Task 7).

- [ ] **Step 1: Read the current file**

Read `src/components/terminal/ActiveAgentsCard.tsx` in full before editing (required by this project's CLAUDE.md: read before editing).

- [ ] **Step 2: Rewrite the component**

Replace the full contents of `src/components/terminal/ActiveAgentsCard.tsx` with:

```tsx
import { useEffect, useState, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { fmtElapsed } from '../../utils/format';

export function ActiveAgentsCard() {
  const { state } = useAetherStore();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flex: 'none' }}>
        <div style={titleStyle}>ACTIVE AGENTS</div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 13 }}>
        {state.realAgents.map((a) => (
          <div key={a.toolUseId} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <span style={avatarStyle}>{a.subagentType.slice(0, 2).toUpperCase()}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textPrimary }}>{a.subagentType}</span>
                <span style={{ font: `700 12px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>{fmtElapsed(now - new Date(a.startedAt).getTime())}</span>
              </div>
              <div style={taskStyle}>{a.description}</div>
            </div>
          </div>
        ))}
        {state.realAgents.length === 0 && <div style={emptyStyle}>no agents currently running</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  padding: 14,
  background: 'rgba(10,22,26,0.55)',
  border: `1px solid ${colors.borderDim ?? 'rgba(127,216,239,0.15)'}`,
  borderRadius: 10,
};

const titleStyle: CSSProperties = {
  font: `700 11px/1 ${fonts.ui}`,
  letterSpacing: 1.2,
  color: colors.textMuted,
};

const avatarStyle: CSSProperties = {
  flex: 'none',
  width: 28,
  height: 28,
  borderRadius: 8,
  display: 'grid',
  placeItems: 'center',
  font: `700 11px/1 ${fonts.mono}`,
  color: colors.accentCyanSoft,
  background: 'rgba(127,216,239,0.12)',
  border: `1px solid ${colors.accentCyanSoft}`,
};

const taskStyle: CSSProperties = {
  font: `500 11px/1.3 ${fonts.ui}`,
  color: colors.textDim,
  marginTop: 2,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const emptyStyle: CSSProperties = {
  font: `500 12px/1.4 ${fonts.ui}`,
  color: colors.textDim,
  padding: '8px 2px',
};
```

**Note for the implementer:** before finalizing, read `src/styles/tokens.ts` to confirm the exact names/values of `colors.textMuted`, `colors.textDim`, `colors.accentCyanSoft`, and `fonts.ui`/`fonts.mono` (all four are already used elsewhere in this codebase, e.g. `src/components/dashboard/useRealUsageSync.ts`'s sibling components) — and confirm whether `colors.borderDim` exists; if it does not, replace `colors.borderDim ?? 'rgba(127,216,239,0.15)'` with whatever border-color token the file's original `cardStyle` used (read the file in Step 1 to find its exact prior value before this rewrite and reuse it verbatim, since preserving the existing card chrome — not just the list content — is part of this task).

- [ ] **Step 3: Manual verification**

Run: `npm run electron:dev`

With the Terminal tab active, confirm: the card renders with no console errors; with `state.realAgents` empty (the default, no Electron agent snapshot yet, or a plain `npm run dev` browser session), the "no agents currently running" empty state shows; the "SPAWN +" button and per-agent click-to-select behavior from the old version are both gone.

- [ ] **Step 4: Run the full suite and type checker**

Run: `npm test && npx tsc -b --noEmit`
Expected: all tests pass (no test file for this component, matching the project's existing convention of no tests for presentational card components — see `ActiveAgentsDigest.tsx`'s prior version, `SystemsCard.tsx`, etc.); `tsc -b` clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/terminal/ActiveAgentsCard.tsx
git commit -m "feat: show real Active Agent dispatches in Terminal's ActiveAgentsCard"
```

---

### Task 6: Rewrite `ActiveAgentsDigest.tsx` (Dashboard)

**Files:**
- Modify: `src/components/dashboard/ActiveAgentsDigest.tsx`

**Interfaces:**
- Consumes: `state.realAgents: RealAgentDispatch[]` (Task 3); `fmtElapsed` from `src/utils/format.ts` (Task 4); `colors`/`fonts` from `../../styles/tokens` (existing).

- [ ] **Step 1: Read the current file**

Read `src/components/dashboard/ActiveAgentsDigest.tsx` in full before editing.

- [ ] **Step 2: Rewrite the component**

Replace the full contents of `src/components/dashboard/ActiveAgentsDigest.tsx` with:

```tsx
import { useEffect, useState, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { fmtElapsed } from '../../utils/format';

export function ActiveAgentsDigest() {
  const { state } = useAetherStore();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>ACTIVE AGENTS</div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 11, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {state.realAgents.map((a) => (
          <div key={a.toolUseId} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={avatarStyle}>{a.subagentType.slice(0, 2).toUpperCase()}</span>
            <span style={nameStyle}>{a.subagentType}</span>
            <span style={{ flex: 'none', font: `700 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>{fmtElapsed(now - new Date(a.startedAt).getTime())}</span>
          </div>
        ))}
        {state.realAgents.length === 0 && <div style={emptyStyle}>no agents currently running</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  padding: 14,
  background: 'rgba(10,22,26,0.55)',
  border: `1px solid ${colors.borderDim ?? 'rgba(127,216,239,0.15)'}`,
  borderRadius: 10,
};

const titleStyle: CSSProperties = {
  font: `700 11px/1 ${fonts.ui}`,
  letterSpacing: 1.2,
  color: colors.textMuted,
};

const avatarStyle: CSSProperties = {
  flex: 'none',
  width: 24,
  height: 24,
  borderRadius: 7,
  display: 'grid',
  placeItems: 'center',
  font: `700 10px/1 ${fonts.mono}`,
  color: colors.accentCyanSoft,
  background: 'rgba(127,216,239,0.12)',
  border: `1px solid ${colors.accentCyanSoft}`,
};

const nameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  font: `600 12px/1 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const emptyStyle: CSSProperties = {
  font: `500 12px/1.4 ${fonts.ui}`,
  color: colors.textDim,
  padding: '8px 2px',
};
```

**Note for the implementer:** as in Task 5, read `src/styles/tokens.ts` to confirm exact token names before finalizing, and reuse this file's own prior `cardStyle` border value (read in Step 1) rather than inventing a new one.

- [ ] **Step 3: Manual verification**

Run: `npm run electron:dev`

With the Dashboard tab active, confirm: the digest renders with no console errors; empty state shows when `state.realAgents` is empty; the "VIEW ALL →" link and click-to-select behavior from the old version are both gone.

- [ ] **Step 4: Run the full suite and type checker**

Run: `npm test && npx tsc -b --noEmit`
Expected: all tests pass; `tsc -b` clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/ActiveAgentsDigest.tsx
git commit -m "feat: show real Active Agent dispatches in Dashboard's ActiveAgentsDigest"
```

---

### Task 7: End-to-end manual verification and PROGRESS.md update

**Files:**
- Modify: `PROGRESS.md`

**Interfaces:**
- Consumes: the fully wired feature from Tasks 1-6. No new code interfaces.

- [ ] **Step 1: Full regression pass**

Run: `npm test && npx tsc -b --noEmit && npm run electron:build`
Expected: full test suite passes, `tsc -b` clean, Electron build succeeds.

- [ ] **Step 2: Live manual verification**

Run: `npm run electron:dev` with a real Claude Code session actively running somewhere on the machine (this session dispatching a subagent is sufficient). Confirm, per the spec's manual verification section:
1. A real dispatch appears in both `ActiveAgentsCard` and `ActiveAgentsDigest` within about a second of it starting, showing its real subagent type and description with a live-ticking elapsed time.
2. The dispatch disappears from both cards only once it actually finishes (compare against when the real work visibly completes) — not within the first second or two.
3. Switching to a different Claude Code session causes the tracker to follow it.
4. Both cards' empty states render correctly when no dispatches are open.
5. Every other view (Agents, Grid, Analytics, Files, Memory, Chat) still renders exactly as before.
6. `npm run dev` (plain browser, no Electron) shows both cards' empty states without crashing.

- [ ] **Step 3: Update PROGRESS.md**

Read `PROGRESS.md` in full, then update its "Right now" section to record Phase 3 (first slice) as shipped: real Active Agent dispatch tracking live in Terminal and Dashboard, sourced from whichever Claude Code session is globally most-recently-active, with the fictional `state.agents` roster still driving every other view. Note the next open question explicitly: whether Phase 3's next increment extends real data to the Agents view itself, adds per-dispatch token/duration history (already available via the completion XML's `<usage>` tag, per the design spec's Non-goals), or moves to a different phase entirely — this is undecided and should be raised with the user, not assumed.

- [ ] **Step 4: Commit**

```bash
git add PROGRESS.md
git commit -m "docs: update PROGRESS.md for real Active Agents (Phase 3, first slice)"
```

---

## Self-Review Notes

**Spec coverage:** Task 1 covers the pure tracking function and its `queue-operation`-must-be-ignored test (the spec's most important test). Task 2 covers the live-tailing pipeline including the "replay full file on every active-file-change" behavior and the IPC surface. Task 3 covers state wiring. Task 4 covers `fmtElapsed`. Tasks 5-6 cover both target components and their resolved SPAWN+/VIEW ALL removals. Task 7 covers the spec's manual verification checklist and documentation. No spec section is without a task.

**Placeholder scan:** no TBD/TODO; every step has complete, runnable code or an exact command with expected output.

**Type consistency:** `RealAgentDispatch` is defined once in Task 1 (`src/state/liveAgentsMath.ts`) and imported by name in every later task (Task 2's `liveAgentTracker.ts`/`preload.ts`/`aetherElectron.d.ts`, Task 3's `types.ts`/`reducer.ts`/`useRealAgentsSync.ts`, Tasks 5-6's components) — never redefined. `applyLinesToOpenDispatches(currentOpen, rawLines)`'s signature is used identically in Task 1's tests and Task 2's `liveAgentTracker.ts`. The IPC channel name `'agents:snapshot'` and the bridge path `window.aetherElectron.agents.onSnapshot` are consistent across Task 2 (preload/main) and Task 3 (the hook).
