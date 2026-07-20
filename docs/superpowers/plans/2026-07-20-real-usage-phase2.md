# Real Dashboard Usage Data (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the token/burn numbers in Dashboard's `ReactorStatusCard` KPI tiles and the global footer's TOKEN USAGE card with real data computed by periodically scanning `~/.claude/projects/**/*.jsonl`, while leaving `tick.ts` and everything it drives completely untouched.

**Architecture:** Pure aggregation math (testable, under `src/`) → an Electron main-process pipeline (ported parser/scanner + a 60s scan interval pushing snapshots over IPC) → renderer consumption (a new state slice, a sync hook, and updates to the two widgets).

**Tech Stack:** No new dependencies — this phase only adds TypeScript/React code, reusing the Electron/IPC infrastructure Phases 0-1 already built.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-20-real-usage-phase2-design.md` (commit `6cd78a1`) — every requirement below is copied verbatim from it.
- `state/tick.ts` is **not modified**. `state.used`/`state.rate`/`state.weekRaw` and everything they drive (agents' `pct`/`hist`, `sys`, logs, notifs, approvals, alarm level, reactor pulse) stay exactly as they are today.
- The CONTEXT KPI tile and the footer's CONTEXT WINDOW card are **not modified** — both keep reading `state.ctxUsed`, still fictional.
- No dollar spend anywhere — real numbers this phase are token counts only.
- No live-tailing — a 60s periodic re-scan only.
- Type-only imports across the `electron/`↔`src/` boundary (`import type {...}`) are safe and need no verification (erased at compile time). **Runtime code imports across that boundary (Task 2's `main.ts` importing the actual aggregation functions) need empirical verification** — write the import, then confirm `electron-vite`'s main bundler actually resolves and bundles it correctly, matching this project's established discipline from Phase 0's build-output-path and Phase 1's preload-format discoveries. Do not assume it works without checking.
- Baseline: 270 passing tests across 26 files, clean `tsc -b`, clean `npm run build`, working tree clean at commit `6cd78a1` (the spec commit).

---

### Task 1: Pure aggregation math

**Files:**
- Create: `src/components/dashboard/realUsageMath.ts`
- Test: `src/components/dashboard/realUsageMath.test.ts`

**Interfaces:**
- Produces: `UsageEvent` (minimal shape: `{ kind: 'assistant' | 'user' | 'other'; timestamp: Date | null; usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number } | null }`), `computeWeeklyTokens(events, now): number[]`, `computeUsedThisMonth(events, now): number`, `computeBurnRatePerMin(events, now): number`, `computeWeekOverWeekPct(events, now): number | null` — consumed by Task 2's `electron/main.ts`. `electron/transcriptParser.ts`'s richer event shape (Task 2) is structurally assignable to this minimal `UsageEvent` — no mapping needed at the call site.

- [ ] **Step 1: Write `realUsageMath.ts`**

```ts
export interface UsageEventUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface UsageEvent {
  kind: 'assistant' | 'user' | 'other';
  timestamp: Date | null;
  usage: UsageEventUsage | null;
}

const BURN_WINDOW_MIN = 10;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function usageTokens(usage: UsageEventUsage | null): number {
  if (!usage) return 0;
  return usage.inputTokens + usage.outputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}

function mondayOf(d: Date): Date {
  const dayOfWeek = d.getDay(); // 0=Sun..6=Sat
  const offset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
}

export function computeWeeklyTokens(events: UsageEvent[], now: Date): number[] {
  const monday = mondayOf(now);
  const buckets = [0, 0, 0, 0, 0, 0, 0];
  for (const e of events) {
    if (e.kind !== 'assistant' || !e.usage || !e.timestamp) continue;
    for (let i = 0; i < 7; i++) {
      const bucketStart = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
      const bucketEnd = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i + 1);
      if (e.timestamp >= bucketStart && e.timestamp < bucketEnd) {
        buckets[i] += usageTokens(e.usage);
        break;
      }
    }
  }
  return buckets;
}

export function computeUsedThisMonth(events: UsageEvent[], now: Date): number {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  let total = 0;
  for (const e of events) {
    if (e.kind !== 'assistant' || !e.usage || !e.timestamp) continue;
    if (e.timestamp >= monthStart && e.timestamp <= now) total += usageTokens(e.usage);
  }
  return total;
}

export function computeBurnRatePerMin(events: UsageEvent[], now: Date): number {
  const windowStart = new Date(now.getTime() - BURN_WINDOW_MIN * 60 * 1000);
  let total = 0;
  for (const e of events) {
    if (e.kind !== 'assistant' || !e.usage || !e.timestamp) continue;
    if (e.timestamp >= windowStart && e.timestamp <= now) total += usageTokens(e.usage);
  }
  return total / BURN_WINDOW_MIN;
}

// Compares this week-so-far against the SAME partial period last week (not
// last week's full total), so a mid-week check doesn't read as a misleading
// "down 80%" just because the current week isn't over yet.
export function computeWeekOverWeekPct(events: UsageEvent[], now: Date): number | null {
  const thisMonday = mondayOf(now);
  const lastMonday = new Date(thisMonday.getTime() - WEEK_MS);
  const lastSamePoint = new Date(lastMonday.getTime() + (now.getTime() - thisMonday.getTime()));

  let thisWeekTotal = 0;
  let lastWeekTotal = 0;
  for (const e of events) {
    if (e.kind !== 'assistant' || !e.usage || !e.timestamp) continue;
    const t = e.timestamp;
    if (t >= thisMonday && t <= now) thisWeekTotal += usageTokens(e.usage);
    else if (t >= lastMonday && t <= lastSamePoint) lastWeekTotal += usageTokens(e.usage);
  }
  if (lastWeekTotal === 0) return null;
  return Math.round(((thisWeekTotal - lastWeekTotal) / lastWeekTotal) * 100);
}
```

- [ ] **Step 2: Write `realUsageMath.test.ts`**

Reference date used throughout: `new Date(2026, 0, 7, 12, 0, 0)` — Wednesday, January 7, 2026, noon (confirmed a Wednesday). Monday of that week is January 5, 2026.

```ts
import { describe, expect, it } from 'vitest';
import { computeWeeklyTokens, computeUsedThisMonth, computeBurnRatePerMin, computeWeekOverWeekPct, type UsageEvent } from './realUsageMath';

const NOW = new Date(2026, 0, 7, 12, 0, 0); // Wednesday, Jan 7 2026, noon

function assistantEvent(timestamp: Date, tokens: number): UsageEvent {
  return { kind: 'assistant', timestamp, usage: { inputTokens: tokens, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } };
}

describe('computeWeeklyTokens', () => {
  it('buckets tokens into the correct day of the current Mon-Sun week', () => {
    const events = [
      assistantEvent(new Date(2026, 0, 5, 9, 0), 100), // Monday
      assistantEvent(new Date(2026, 0, 7, 10, 0), 50), // Wednesday
      assistantEvent(new Date(2026, 0, 7, 11, 0), 25), // Wednesday, same bucket
    ];
    expect(computeWeeklyTokens(events, NOW)).toEqual([100, 0, 75, 0, 0, 0, 0]);
  });

  it('returns all zeros for an empty event array', () => {
    expect(computeWeeklyTokens([], NOW)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('ignores non-assistant events and events with no usage', () => {
    const events: UsageEvent[] = [
      { kind: 'user', timestamp: new Date(2026, 0, 7, 9, 0), usage: null },
      { kind: 'assistant', timestamp: new Date(2026, 0, 7, 9, 0), usage: null },
    ];
    expect(computeWeeklyTokens(events, NOW)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('ignores events from outside the current week', () => {
    const events = [assistantEvent(new Date(2025, 11, 29, 9, 0), 100)]; // prior Monday
    expect(computeWeeklyTokens(events, NOW)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('computeUsedThisMonth', () => {
  it('sums tokens since the start of the current month', () => {
    const events = [assistantEvent(new Date(2026, 0, 1, 0, 0), 200), assistantEvent(new Date(2026, 0, 7, 9, 0), 300)];
    expect(computeUsedThisMonth(events, NOW)).toBe(500);
  });

  it('excludes tokens from the previous month', () => {
    const events = [assistantEvent(new Date(2025, 11, 31, 23, 59), 999), assistantEvent(new Date(2026, 0, 7, 9, 0), 100)];
    expect(computeUsedThisMonth(events, NOW)).toBe(100);
  });

  it('returns 0 for an empty event array', () => {
    expect(computeUsedThisMonth([], NOW)).toBe(0);
  });
});

describe('computeBurnRatePerMin', () => {
  it('averages tokens from the last 10 minutes over 10 minutes', () => {
    const events = [assistantEvent(new Date(NOW.getTime() - 5 * 60 * 1000), 100)];
    expect(computeBurnRatePerMin(events, NOW)).toBe(10);
  });

  it('excludes tokens older than the 10-minute window', () => {
    const events = [assistantEvent(new Date(NOW.getTime() - 15 * 60 * 1000), 1000)];
    expect(computeBurnRatePerMin(events, NOW)).toBe(0);
  });

  it('returns 0 for an empty event array', () => {
    expect(computeBurnRatePerMin([], NOW)).toBe(0);
  });
});

describe('computeWeekOverWeekPct', () => {
  it('returns null when there is no prior-week data to compare against', () => {
    const events = [assistantEvent(new Date(2026, 0, 7, 9, 0), 100)];
    expect(computeWeekOverWeekPct(events, NOW)).toBeNull();
  });

  it('computes a positive percent change when this week is higher', () => {
    const events = [
      assistantEvent(new Date(2025, 11, 31, 9, 0), 100), // last Wed (same relative point)
      assistantEvent(new Date(2026, 0, 7, 9, 0), 150), // this Wed
    ];
    expect(computeWeekOverWeekPct(events, NOW)).toBe(50);
  });

  it('computes a negative percent change when this week is lower', () => {
    const events = [assistantEvent(new Date(2025, 11, 31, 9, 0), 200), assistantEvent(new Date(2026, 0, 7, 9, 0), 100)];
    expect(computeWeekOverWeekPct(events, NOW)).toBe(-50);
  });
});
```

- [ ] **Step 3: Run the new tests, then the full suite**

Run: `npx vitest run src/components/dashboard/realUsageMath.test.ts`
Expected: PASS, 13/13 tests.

Run: `npm test && npx tsc -b && npm run build`
Expected: 283/283 tests (270 + 13 new), 27 files, 0 type errors, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/realUsageMath.ts src/components/dashboard/realUsageMath.test.ts
git commit -m "feat: add pure aggregation math for real Dashboard usage data"
```

---

### Task 2: State slice + Electron ingestion pipeline

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/reducer.ts`
- Create: `electron/transcriptParser.ts`
- Create: `electron/historyScanner.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/aetherElectron.d.ts`

**Interfaces:**
- Consumes: Task 1's `computeWeeklyTokens`/`computeUsedThisMonth`/`computeBurnRatePerMin`/`computeWeekOverWeekPct`.
- Produces: `AetherState.realUsage: RealUsageSnapshot`, the `SET_REAL_USAGE` action, and `window.aetherElectron.usage.onSnapshot(callback): () => void` — consumed by Task 3's sync hook.

- [ ] **Step 1: Add `RealUsageSnapshot` and the `realUsage` field to `types.ts`**

Add near `TermLine`/other small interfaces:

```ts
export interface RealUsageSnapshot {
  weeklyTokens: number[];
  usedThisMonth: number;
  burnRatePerMin: number;
  weekOverWeekPct: number | null;
  lastScanAt: string | null;
}
```

Add to `AetherState` (anywhere among the other top-level fields, e.g. after `chatActionResults`):

```ts
  realUsage: RealUsageSnapshot;
```

- [ ] **Step 2: Seed `initialState.ts`**

Add (anywhere among the other top-level fields, e.g. after `chatActionResults: [],`):

```ts
  realUsage: { weeklyTokens: [0, 0, 0, 0, 0, 0, 0], usedThisMonth: 0, burnRatePerMin: 0, weekOverWeekPct: null, lastScanAt: null },
```

This is also exactly the state a plain-browser session (`npm run dev`) permanently shows — no special "requires Electron" fallback UI needed for these widgets (per the design spec).

- [ ] **Step 3: Add the `SET_REAL_USAGE` action to `reducer.ts`**

Add to the `Action` union:

```ts
  | { type: 'SET_REAL_USAGE'; snapshot: RealUsageSnapshot }
```

(Add `RealUsageSnapshot` to this file's existing `import type { ... } from './types'` line.)

Add the case (anywhere among the other simple field-replacement cases):

```ts
    case 'SET_REAL_USAGE':
      return { ...state, realUsage: action.snapshot };
```

- [ ] **Step 4: Write `electron/transcriptParser.ts`**

TypeScript port of TokenMonitor's `src/shared/transcriptParser.js`, typed, keeping its full normalized shape (not just the minimal fields this phase consumes — `sessionId`/`cwd`/`model`/`toolUses` etc. are kept for a future phase, even though only `kind`/`timestamp`/`usage` matter here):

```ts
export interface TranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface TranscriptToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface TranscriptToolResult {
  toolUseId: string;
}

export interface TranscriptEvent {
  kind: 'assistant' | 'user' | 'other';
  sessionId: string | null;
  timestamp: Date | null;
  cwd: string | null;
  model: string | null;
  usage: TranscriptUsage | null;
  toolUses: TranscriptToolUse[];
  toolResults: TranscriptToolResult[];
  isHumanPrompt: boolean;
  humanText: string | null;
}

export function parseTranscriptLine(rawLine: string): TranscriptEvent | null {
  const trimmed = (rawLine || '').trim();
  if (!trimmed) return null;

  let json: any;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const sessionId = json.sessionId || json.session_id || null;
  const timestamp = json.timestamp ? new Date(json.timestamp) : null;
  const cwd = json.cwd || null;

  if (json.type === 'assistant' && json.message) {
    const msg = json.message;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const toolUses = content
      .filter((item: any) => item.type === 'tool_use')
      .map((item: any) => ({ id: item.id, name: item.name, input: item.input }));
    const usage = msg.usage
      ? {
          inputTokens: msg.usage.input_tokens || 0,
          outputTokens: msg.usage.output_tokens || 0,
          cacheCreationInputTokens: msg.usage.cache_creation_input_tokens || 0,
          cacheReadInputTokens: msg.usage.cache_read_input_tokens || 0,
        }
      : null;
    return {
      kind: 'assistant',
      sessionId,
      timestamp,
      cwd,
      model: msg.model || null,
      usage,
      toolUses,
      toolResults: [],
      isHumanPrompt: false,
      humanText: null,
    };
  }

  if (json.type === 'user' && json.message) {
    const msg = json.message;
    const content = Array.isArray(msg.content)
      ? msg.content
      : typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : [];
    const toolResults = content
      .filter((item: any) => item.type === 'tool_result')
      .map((item: any) => ({ toolUseId: item.tool_use_id }));
    const textItem = content.find((item: any) => item.type === 'text');
    const isHumanPrompt = toolResults.length === 0 && !!textItem;
    return {
      kind: 'user',
      sessionId,
      timestamp,
      cwd,
      model: null,
      usage: null,
      toolUses: [],
      toolResults,
      isHumanPrompt,
      humanText: textItem ? textItem.text : null,
    };
  }

  return {
    kind: 'other',
    sessionId,
    timestamp,
    cwd,
    model: null,
    usage: null,
    toolUses: [],
    toolResults: [],
    isHumanPrompt: false,
    humanText: null,
  };
}
```

- [ ] **Step 5: Write `electron/historyScanner.ts`**

TypeScript port of TokenMonitor's `src/main/historyScanner.js`:

```ts
import { promises as fsp } from 'fs';
import path from 'path';
import { parseTranscriptLine, type TranscriptEvent } from './transcriptParser';

export async function scanAllProjects(projectsRoot: string): Promise<TranscriptEvent[]> {
  const events: TranscriptEvent[] = [];
  let projectDirs;
  try {
    projectDirs = await fsp.readdir(projectsRoot, { withFileTypes: true });
  } catch (err: any) {
    if (err.code === 'ENOENT') return events;
    throw err;
  }

  for (const dirEntry of projectDirs) {
    if (!dirEntry.isDirectory()) continue;
    const dirPath = path.join(projectsRoot, dirEntry.name);
    const files = await fsp.readdir(dirPath);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const content = await fsp.readFile(path.join(dirPath, file), 'utf8');
      for (const line of content.split('\n')) {
        const event = parseTranscriptLine(line);
        if (event) events.push(event);
      }
    }
  }
  return events;
}
```

- [ ] **Step 6: Modify `electron/main.ts`**

Add imports, a stored window reference, and the scan/interval/push wiring. Full replacement file:

```ts
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import os from 'node:os';
import { spawnPty } from './ptyManager';
import { scanAllProjects } from './historyScanner';
import { computeWeeklyTokens, computeUsedThisMonth, computeBurnRatePerMin, computeWeekOverWeekPct } from '../src/components/dashboard/realUsageMath';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
    },
  });
  mainWindow = win;

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

const USAGE_SCAN_INTERVAL_MS = 60000;

async function scanAndPushUsage(): Promise<void> {
  if (!mainWindow) return;
  const projectsRoot = join(os.homedir(), '.claude', 'projects');
  const events = await scanAllProjects(projectsRoot);
  const now = new Date();
  mainWindow.webContents.send('usage:snapshot', {
    weeklyTokens: computeWeeklyTokens(events, now),
    usedThisMonth: computeUsedThisMonth(events, now),
    burnRatePerMin: computeBurnRatePerMin(events, now),
    weekOverWeekPct: computeWeekOverWeekPct(events, now),
    lastScanAt: now.toISOString(),
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  scanAndPushUsage();
  setInterval(scanAndPushUsage, USAGE_SCAN_INTERVAL_MS);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let activePty: ReturnType<typeof spawnPty> | null = null;

ipcMain.handle('pty:start', (event, { cols, rows }: { cols: number; rows: number }) => {
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

**Important — this is the one part of this plan that needs empirical verification, not blind trust (Global Constraints):** the `import { ... } from '../src/components/dashboard/realUsageMath'` line pulls real runtime code across the `electron/`↔`src/` boundary, unlike every prior cross-boundary import in this project (which have all been type-only). After writing this, run `npm run electron:build` and inspect the actual output (`out/main/main.js` or wherever the real filename lands) to confirm `computeWeeklyTokens` and friends genuinely got bundled in, not silently dropped or left as an unresolved external. If it doesn't bundle cleanly, the fallback is copying `realUsageMath.ts`'s contents into `electron/` directly (accepting duplication over a broken cross-boundary import) — but attempt the clean shared-import approach first and only fall back if it demonstrably fails.

- [ ] **Step 7: Modify `electron/preload.ts`**

Add the `usage` surface. Full replacement file:

```ts
import { contextBridge, ipcRenderer } from 'electron';
import type { RealUsageSnapshot } from '../src/state/types';

contextBridge.exposeInMainWorld('aetherElectron', {
  pty: {
    start: (opts: { cols: number; rows: number }) => ipcRenderer.invoke('pty:start', opts),
    write: (input: string) => ipcRenderer.send('pty:write', input),
    resize: (cols: number, rows: number) => ipcRenderer.send('pty:resize', { cols, rows }),
    onData: (callback: (data: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: string) => callback(data);
      ipcRenderer.on('pty:data', listener);
      return () => ipcRenderer.removeListener('pty:data', listener);
    },
  },
  usage: {
    onSnapshot: (callback: (snapshot: RealUsageSnapshot) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: RealUsageSnapshot) => callback(snapshot);
      ipcRenderer.on('usage:snapshot', listener);
      return () => ipcRenderer.removeListener('usage:snapshot', listener);
    },
  },
});
```

(`import type` is erased at compile time — this specific cross-boundary import needs no runtime-bundling verification, unlike Step 6's.)

- [ ] **Step 8: Modify `src/aetherElectron.d.ts`**

Full replacement file:

```ts
import type { RealUsageSnapshot } from './state/types';

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
      usage: {
        onSnapshot: (callback: (snapshot: RealUsageSnapshot) => void) => () => void;
      };
    };
  }
}
```

- [ ] **Step 9: Verify**

Run: `npm test && npx tsc -b && npm run build`
Expected: 283/283 tests unchanged, 27 files, 0 type errors, build succeeds.

Run: `npx tsc -p electron/tsconfig.json`
Expected: 0 errors.

Run: `npm run electron:build`
Expected: succeeds. Per Step 6's note, inspect the actual output to confirm `realUsageMath`'s functions are genuinely bundled into the main process output, not dropped.

- [ ] **Step 10: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/reducer.ts electron/transcriptParser.ts electron/historyScanner.ts electron/main.ts electron/preload.ts src/aetherElectron.d.ts
git commit -m "feat: add the real usage-data ingestion pipeline (main process)"
```

---

### Task 3: Renderer consumption (Dashboard widgets)

**Files:**
- Create: `src/components/dashboard/useRealUsageSync.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/dashboard/dashboardMath.ts`
- Modify: `src/components/dashboard/dashboardMath.test.ts`
- Modify: `src/components/layout/BottomMetricsRow.tsx`

**Interfaces:**
- Consumes: Task 2's `window.aetherElectron.usage.onSnapshot` and `state.realUsage`.

- [ ] **Step 1: Write `useRealUsageSync.ts`**

Mirrors this project's existing `usePulseDurationVar()` pattern (a small effect-only hook called once at the App root):

```ts
import { useEffect } from 'react';
import { useAetherStore } from '../../state/store';

export function useRealUsageSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const usage = window.aetherElectron?.usage;
    if (!usage) return;
    return usage.onSnapshot((snapshot) => {
      dispatch({ type: 'SET_REAL_USAGE', snapshot });
    });
  }, [dispatch]);
}
```

- [ ] **Step 2: Wire it into `App.tsx`**

Add the import and a `RealUsageSync` component, rendered alongside the existing `PulseDurationSync`:

```tsx
import { AetherStoreProvider, useAetherStore } from './state/store';
import { AppShell } from './components/layout/AppShell';
import { ComingSoonPanel } from './components/layout/ComingSoonPanel';
import { BottomMetricsRow } from './components/layout/BottomMetricsRow';
import { getViewComponent } from './viewRegistry';
import { usePulseDurationVar } from './components/reactor/useReactorCanvas';
import { useRealUsageSync } from './components/dashboard/useRealUsageSync';

function ActiveView() {
  const { state } = useAetherStore();
  const Component = getViewComponent(state.activeTab);
  if (Component) return <Component />;
  return <ComingSoonPanel tabName={state.activeTab} />;
}

export default function App() {
  return (
    <AetherStoreProvider>
      <AppShell>
        <PulseDurationSync />
        <RealUsageSync />
        <ActiveView />
        <BottomMetricsRow />
      </AppShell>
    </AetherStoreProvider>
  );
}

function PulseDurationSync() {
  usePulseDurationVar();
  return null;
}

function RealUsageSync() {
  useRealUsageSync();
  return null;
}
```

- [ ] **Step 3: Modify `computeDashKpis` in `dashboardMath.ts`**

Change from reading `state.used`/`state.rate` to `state.realUsage.usedThisMonth`/`state.realUsage.burnRatePerMin`; drop the fake dollar-spend subtitle (Global Constraints: no dollar spend anywhere). `computeDashStatus`/`computeDashPulseMode` are untouched.

```ts
export function computeDashKpis(state: AetherState): DashKpi[] {
  const capTokens = state.cfg.capM * 1e6;
  const used = state.realUsage.usedThisMonth;
  const budgetLeftPct = Math.max(0, 100 - (used / capTokens) * 100);
  const remaining = Math.max(0, capTokens - used);
  const ctxPct = Math.round(state.ctxUsed / 1250);

  return [
    { k: 'SESSION TOKENS', v: short(used), s: 'this month' },
    { k: 'BUDGET LEFT', v: `${budgetLeftPct.toFixed(1)}%`, s: `of ${state.cfg.capM.toFixed(1)}M cap` },
    { k: 'DEPLETION ETA', v: fmtEta(remaining / (state.realUsage.burnRatePerMin / 60)), s: 'at current draw' },
    { k: 'CONTEXT', v: `${ctxPct}%`, s: `${short(state.ctxUsed)} / 125K` },
  ];
}
```

(`remaining / 0` correctly produces `Infinity` when `burnRatePerMin` is 0, which `fmtEta` already renders as `'n/a'` — confirmed by reading `fmtEta`'s existing implementation before writing this plan; no new edge-case handling needed.)

- [ ] **Step 4: Update `dashboardMath.test.ts`'s `computeDashKpis` tests**

Change the two existing tests' state overrides from `used`/`rate` to `realUsage`, and update the first test's expected subtitle:

```ts
describe('computeDashKpis', () => {
  it('derives all four KPI tiles from state', () => {
    const kpis = computeDashKpis({
      ...initialState,
      realUsage: { ...initialState.realUsage, usedThisMonth: 24391, burnRatePerMin: 92000 },
      ctxUsed: 78432,
      cfg: { ...initialState.cfg, capM: 2.0 },
    });
    expect(kpis).toHaveLength(4);
    expect(kpis[0]).toEqual({ k: 'SESSION TOKENS', v: '24.4K', s: 'this month' });
    expect(kpis[1].k).toBe('BUDGET LEFT');
    expect(kpis[1].v).toBe('98.8%');
    expect(kpis[1].s).toBe('of 2.0M cap');
    expect(kpis[2].k).toBe('DEPLETION ETA');
    expect(kpis[3]).toEqual({ k: 'CONTEXT', v: '63%', s: '78.4K / 125K' });
  });

  it('clamps budget-left at 0% instead of going negative', () => {
    const kpis = computeDashKpis({
      ...initialState,
      realUsage: { ...initialState.realUsage, usedThisMonth: 5_000_000 },
      cfg: { ...initialState.cfg, capM: 2.0 },
    });
    expect(kpis[1].v).toBe('0.0%');
  });
});
```

- [ ] **Step 5: Modify `BottomMetricsRow.tsx`**

Replace the weekly-bar/total computation (lines computing `maxBar`/`weekly`/`weekTotal`), the hardcoded trend text, and the SESSION INFO "Tokens used" row's source field:

```tsx
const maxBar = Math.max(...state.realUsage.weeklyTokens, 1); // avoid /0 before the first real scan completes
const weekly = state.realUsage.weeklyTokens.map((v, i) => ({ d: DAY_LABELS[i], h: Math.round(20 + (v / maxBar) * 52) }));
const weekTotal = fmt(state.realUsage.weeklyTokens.reduce((sum, v) => sum + v, 0));
```

Replace the hardcoded trend `<div>` (currently `<div style={{ font: ..., color: colors.success, marginTop: 6 }}>▼ 12% vs last wk</div>`) with:

```tsx
{state.realUsage.weekOverWeekPct !== null && (
  <div
    style={{
      font: `400 11px/1 ${fonts.ui}`,
      color: state.realUsage.weekOverWeekPct <= 0 ? colors.success : colors.warn,
      marginTop: 6,
    }}
  >
    {state.realUsage.weekOverWeekPct <= 0 ? '▼' : '▲'} {Math.abs(state.realUsage.weekOverWeekPct)}% vs last wk
  </div>
)}
```

In the `session` array, change:

```ts
{ k: 'Tokens used', v: fmt(state.used) },
```

to:

```ts
{ k: 'Tokens used', v: fmt(state.realUsage.usedThisMonth) },
```

- [ ] **Step 6: Run the full suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: 283/283 tests (no new tests this task — Steps 4's changes are edits to existing tests, not new ones), 27 files, 0 type errors, build succeeds.

- [ ] **Step 7: Manual verification**

Run `npm run electron:dev`:
1. Confirm the app launches and, within the first scan cycle, `ReactorStatusCard`'s SESSION TOKENS/BUDGET LEFT/DEPLETION ETA and the footer's TOKEN USAGE weekly bars show real numbers (sanity-check against what's actually in `~/.claude/projects`, not exact-value verification).
2. Confirm CONTEXT (both the KPI tile and the footer's CONTEXT WINDOW card) is unchanged — still driven by the existing fictional simulation.
3. Confirm the footer's SESSION INFO "Tokens used" row now matches `ReactorStatusCard`'s SESSION TOKENS tile (both reading the same real value) — previously the two were different numbers.
4. Confirm every other view (Agents, Grid, Analytics, etc.) still renders normally — agent `pct`/`hist`, `sys` metrics, logs, and the alarm level are all unaffected.
5. Confirm `npm run dev` (plain browser) shows the same all-zero `realUsage` state without crashing.

- [ ] **Step 8: Commit**

```bash
git add src/components/dashboard/useRealUsageSync.ts src/App.tsx src/components/dashboard/dashboardMath.ts src/components/dashboard/dashboardMath.test.ts src/components/layout/BottomMetricsRow.tsx
git commit -m "feat: render real Dashboard usage data in the KPI tiles and footer"
```

---

### Task 4: Final integration QA

**Files:** None (verification only).

- [ ] **Step 1: Re-run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: 283/283 tests, 27 files, 0 type errors, build succeeds.

- [ ] **Step 2: Manual GUI verification checklist**

Using `npm run electron:dev`:
1. All items from Task 3 Step 7, re-confirmed on the final integrated state.
2. Wait through one 60s interval and confirm the numbers refresh (or stay the same, if no new activity occurred) without a page reload.
3. Confirm the real terminal (Phase 1) and every other simulated surface (Agents' spawn/kill, Dashboard's spawn/sweep, Settings' theme/renderer, Memory's remember input) still work exactly as before — this phase should have zero effect on anything outside the specific widgets named in the design spec's Goal.

- [ ] **Step 3: Report results**

No commit for this task (verification only) unless a regression is found, in which case fix it, re-run Steps 1-2, and commit the fix separately.
