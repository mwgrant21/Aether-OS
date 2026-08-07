# Real Projects View (Stage 16) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Projects view's fictional roster with real projects derived
from transcript `cwd`, with per-project cost as the answer to a click.

**Architecture:** Five movements. (1) A pure, filesystem-injected resolver turning
a `cwd` into a project identity. (2) Pure grouping/nesting math. (3) A
`projects:snapshot` IPC channel built in main by grouping the `TranscriptEvent[]`
it already scans and reusing `buildLedgerSnapshot` per group. (4) The roster and
detail components. (5) Removal of the fictional data and everything that fed on it.

**Tech Stack:** TypeScript (strict), React 18, Electron, Vitest.

## Global Constraints

- Full spec: `docs/superpowers/specs/2026-08-07-real-projects-view-design.md`.
  **Read "The data reality" and "Known limitations" before writing code** — the
  directory layout is not the project list, and that is the whole premise.
- **No absolute path may cross IPC or enter the store.**
  `docs/privacy-and-data.md` is binding: store project-relative, display
  basenames only. Keys are hashes; names are basenames.
- **Worktree identity resolves from the path string BEFORE any filesystem
  probe.** History references worktrees deleted from disk; a filesystem-first
  resolver silently drops their cost.
- **`null` and `0` stay different**, inherited from Stage 15. A project with
  observed-but-free activity is `0`; a period with nothing observed is `null`.
- Use `useColors()` and the `Button` primitive per established conventions.
- `npm test`, `npx tsc -b`, and `npm run build` clean before every commit. Tasks
  3 and 6 touch `electron/`, so those also run `npm run electron:build`.
- Tasks 1–5 must each leave the app working. The fictional data is not removed
  until Task 6, so `state.projects` and the new snapshot coexist until then.

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/projectIdentity.ts` (new) | Pure: `cwd` → `{ repoPath, repoName, worktree }`. Injected `GitProbe`. No crypto, no `node:` imports. |
| `src/shared/projectsSnapshot.ts` (new) | Pure: group events by project, nest worktrees, sort, build `ProjectsSnapshot`. |
| `electron/main.ts` (modify) | Real `GitProbe`, hashing, `projects:snapshot` push + `:current` pull. |
| `electron/preload.ts`, `src/aetherElectron.d.ts` (modify) | Channel exposure. |
| `src/state/types.ts`, `reducer.ts`, `initialState.ts`, `persistence.ts` (modify) | `projectsSnapshot` state, `SET_PROJECTS_SNAPSHOT`, persistence exclusion. |
| `src/state/useProjectsSync.ts` (new) | Mirrors `useLedgerSync`, including the mount-time pull. |
| `src/components/projects/ProjectRosterCard.tsx` (rewrite) | Two-level roster, expand/collapse, cost-desc. |
| `src/components/projects/ProjectDetailCard.tsx` (rewrite) | Composes the Stage 15 cards for one project. |
| `src/components/projects/projectsMath.ts` (rewrite) | Selection helper only; fictional helpers deleted. |
| `src/components/dashboard/ProjectsDigest.tsx` (rewrite) | Top projects by cost. |

**Two deliberate deviations from the spec, both recorded rather than silent:**

1. **Hashing moves to main.** The spec put `repoKey` (a sha256) on the resolver's
   return. Hashing needs `node:crypto`, which must not be imported into a module
   under `src/shared/` — the renderer could pull it into the bundle. The resolver
   returns **paths**; `main.ts`, the only caller and the only place paths are
   allowed, does the hashing. The privacy rule is unchanged: still sha256, still
   first 12 hex chars, still no path crossing IPC.
2. **A worktree's key is derived, not hashed from its own path.** The spec said a
   worktree hashes its own normalised path. Rule 1 returns the *parent* repo path
   plus a worktree name and deliberately never reconstructs the worktree's own
   path — that path may not exist. Its key is therefore
   `sha256(repoPath + '#' + worktreeName)`, which is equally stable and equally
   opaque, and still carries no path across IPC.

---

### Task 1: The project identity resolver

**Files:**
- Create: `src/shared/projectIdentity.ts`, `src/shared/projectIdentity.test.ts`

**Interfaces:**
- Produces: `normalizePath(p: string): string`,
  `resolveProject(cwd: string | null, probe: GitProbe): ProjectRef | null`,
  `type GitProbe = (dir: string) => boolean`,
  `interface ProjectRef { repoPath: string; repoName: string; worktree: string | null }`.
  All paths returned are already normalized.

- [ ] **Step 1: Write the failing tests**

```ts
// src/shared/projectIdentity.test.ts
import { describe, it, expect } from 'vitest';
import { normalizePath, resolveProject, type GitProbe } from './projectIdentity';

// A probe that answers true only for the exact directories listed.
const probeFor = (repos: string[]): GitProbe => {
  const set = new Set(repos.map(normalizePath));
  return (dir) => set.has(normalizePath(dir));
};

const NO_REPOS: GitProbe = () => false;

describe('normalizePath', () => {
  it('lowercases the drive letter, forward-slashes, and strips a trailing separator', () => {
    expect(normalizePath('C:\\Users\\IT\\Desktop\\Aether-OS\\')).toBe('c:/Users/IT/Desktop/Aether-OS');
    expect(normalizePath('c:/Users/IT/Desktop/Aether-OS')).toBe('c:/Users/IT/Desktop/Aether-OS');
  });
});

describe('resolveProject', () => {
  const AETHER = 'C:\\Users\\IT\\Desktop\\Aether-OS';

  it('resolves a repo root to itself with no worktree', () => {
    expect(resolveProject(AETHER, probeFor([AETHER]))).toEqual({
      repoPath: normalizePath(AETHER),
      repoName: 'Aether-OS',
      worktree: null,
    });
  });

  it('rolls a subdirectory up to its repo root', () => {
    const sub = 'C:\\Users\\IT\\Desktop\\TokenMonitorV2\\src\\renderer';
    const repo = 'C:\\Users\\IT\\Desktop\\TokenMonitorV2';
    expect(resolveProject(sub, probeFor([repo]))?.repoName).toBe('TokenMonitorV2');
  });

  // Rule 1 must not consult the filesystem: this worktree no longer exists.
  it('identifies a .claude/worktrees path with no filesystem support at all', () => {
    const wt = 'C:\\Users\\IT\\Desktop\\Aether-OS\\.claude\\worktrees\\statusline-feed';
    expect(resolveProject(wt, NO_REPOS)).toEqual({
      repoPath: normalizePath(AETHER),
      repoName: 'Aether-OS',
      worktree: 'statusline-feed',
    });
  });

  it('identifies a .worktrees path the same way', () => {
    const wt = 'C:\\Users\\IT\\Desktop\\Aether-OS\\.worktrees\\feature-x';
    expect(resolveProject(wt, NO_REPOS)?.worktree).toBe('feature-x');
  });

  it('rolls a subdirectory inside a worktree up to that worktree', () => {
    const deep = 'C:\\Users\\IT\\Desktop\\Aether-OS\\.claude\\worktrees\\wt1\\src\\state';
    const r = resolveProject(deep, NO_REPOS);
    expect(r?.worktree).toBe('wt1');
    expect(r?.repoName).toBe('Aether-OS');
  });

  // The stray C:\Users\IT\Desktop\.git on this machine must not capture repos
  // nested under it -- nearest wins.
  it('prefers the innermost repo when a stray repo exists above it', () => {
    const repo = 'C:\\Users\\IT\\Desktop\\Aether-OS';
    const stray = 'C:\\Users\\IT\\Desktop';
    expect(resolveProject(repo, probeFor([repo, stray]))?.repoName).toBe('Aether-OS');
  });

  it('falls back to the stray repo only for a path that is not itself a repo', () => {
    const loose = 'C:\\Users\\IT\\Desktop\\loose-folder';
    expect(resolveProject(loose, probeFor(['C:\\Users\\IT\\Desktop']))?.repoName).toBe('Desktop');
  });

  it('returns null for a path with no repo ancestor', () => {
    expect(resolveProject('C:\\Users\\IT', NO_REPOS)).toBeNull();
  });

  it('returns null for a null or empty cwd', () => {
    expect(resolveProject(null, NO_REPOS)).toBeNull();
    expect(resolveProject('', NO_REPOS)).toBeNull();
  });

  it('treats differently-cased and differently-separated paths as one project', () => {
    const a = resolveProject('C:\\Users\\IT\\Desktop\\Aether-OS', probeFor(['C:\\Users\\IT\\Desktop\\Aether-OS']));
    const b = resolveProject('c:/Users/IT/Desktop/Aether-OS/', probeFor(['C:\\Users\\IT\\Desktop\\Aether-OS']));
    expect(a?.repoPath).toBe(b?.repoPath);
  });

  it('probes each ancestor at most once and terminates at the drive root', () => {
    const seen: string[] = [];
    const counting: GitProbe = (dir) => { seen.push(dir); return false; };
    resolveProject('C:\\a\\b\\c', counting);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeLessThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/shared/projectIdentity.test.ts`
Expected: FAIL — cannot resolve `./projectIdentity`.

- [ ] **Step 3: Write the implementation**

```ts
// src/shared/projectIdentity.ts

/**
 * Turns a transcript event's `cwd` into a project identity.
 *
 * Pure and filesystem-injected. The probe is a parameter rather than a direct
 * fs call so every case below is testable without touching disk, and so this
 * module carries no `node:` import that could reach the renderer bundle.
 */

export interface ProjectRef {
  /** Normalized absolute path of the repo root. Never leaves the main process. */
  repoPath: string;
  /** Basename of repoPath -- the only part safe to display or transmit. */
  repoName: string;
  /** Worktree name, or null for the repo's own checkout. */
  worktree: string | null;
}

/** True when `<dir>/.git` exists as either a directory or a file. */
export type GitProbe = (dir: string) => boolean;

/**
 * Lowercase the drive letter, forward-slash the separators, drop a trailing
 * separator. Without this, `C:\...\Aether-OS` and `c:/.../aether-os/` become
 * two different projects.
 */
export function normalizePath(p: string): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return slashed.replace(/^([a-zA-Z]):/, (_m, drive: string) => `${drive.toLowerCase()}:`);
}

// Matches `/.claude/worktrees/<name>` or `/.worktrees/<name>`, capturing the
// prefix (the parent repo) and the worktree name.
const WORKTREE_RE = /^(.*?)\/(?:\.claude\/worktrees|\.worktrees)\/([^/]+)(?:\/.*)?$/;

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function parentOf(path: string): string | null {
  const i = path.lastIndexOf('/');
  if (i <= 0) return null;
  const parent = path.slice(0, i);
  // `c:` is the drive root -- stop rather than looping on it.
  return /^[a-z]:$/.test(parent) ? null : parent;
}

export function resolveProject(cwd: string | null, probe: GitProbe): ProjectRef | null {
  if (!cwd) return null;
  const path = normalizePath(cwd);
  if (!path) return null;

  // Rule 1 -- worktree by path shape. Deliberately BEFORE any probe: a worktree
  // deleted from disk must stay attributable to its parent repo.
  const wt = WORKTREE_RE.exec(path);
  if (wt) {
    const repoPath = wt[1];
    return { repoPath, repoName: basename(repoPath), worktree: wt[2] };
  }

  // Rule 2 -- nearest ancestor with a .git entry. Nearest, so a stray repo
  // above a real one never captures it.
  for (let dir: string | null = path; dir !== null; dir = parentOf(dir)) {
    if (probe(dir)) return { repoPath: dir, repoName: basename(dir), worktree: null };
  }

  // Rule 3 -- unattributable.
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/shared/projectIdentity.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc -b` (expect exit 0), then:

```bash
git add src/shared/projectIdentity.ts src/shared/projectIdentity.test.ts
git commit -m "feat(projects): add the cwd-to-project identity resolver"
```

---

### Task 2: Grouping, nesting and the snapshot shape

**Files:**
- Create: `src/shared/projectsSnapshot.ts`, `src/shared/projectsSnapshot.test.ts`

**Interfaces:**
- Consumes: `resolveProject`, `GitProbe`, `ProjectRef` (Task 1);
  `buildLedgerSnapshot`, `type LedgerSnapshot` from `./ledgerMath`;
  `TranscriptEvent` from `../../electron/transcriptParser`.
- Produces:
  `buildProjectsSnapshot(events, probe, keyOf, timeZone, nowMs): ProjectsSnapshot`,
  where `keyOf: (repoPath: string) => string` is injected so hashing stays in main.
  Types `ProjectNode`, `ProjectRoot`, `ProjectsSnapshot`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/shared/projectsSnapshot.test.ts
import { describe, it, expect } from 'vitest';
import type { TranscriptEvent } from '../../electron/transcriptParser';
import { buildProjectsSnapshot } from './projectsSnapshot';
import { sessionLedger } from './ledgerMath';
import { normalizePath, type GitProbe } from './projectIdentity';

const NOW = Date.UTC(2026, 7, 7, 12, 0, 0);
const M = 1_000_000;

const AETHER = 'C:\\Users\\IT\\Desktop\\Aether-OS';
const TOKEN = 'C:\\Users\\IT\\Desktop\\TokenMonitorV2';
const probe: GitProbe = (dir) =>
  [AETHER, TOKEN].map(normalizePath).includes(normalizePath(dir));

// Identity key function -- the real one hashes; tests want readable keys.
const keyOf = (repoPath: string) => repoPath;

function ev(cwd: string | null, outputTokens: number): TranscriptEvent {
  return {
    kind: 'assistant', sessionId: 's', timestamp: new Date(NOW), cwd,
    model: 'claude-sonnet-4-6',
    usage: { inputTokens: 0, outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    toolUses: [], toolResults: [], isHumanPrompt: false, humanText: null, originKind: null,
  };
}

describe('buildProjectsSnapshot', () => {
  it('returns empty roots and null unscoped for no events', () => {
    const s = buildProjectsSnapshot([], probe, keyOf, 'UTC', NOW);
    expect(s.roots).toEqual([]);
    expect(s.unscoped).toBeNull();
  });

  it('groups events under their repo', () => {
    const s = buildProjectsSnapshot([ev(AETHER, M), ev(TOKEN, M / 2)], probe, keyOf, 'UTC', NOW);
    expect(s.roots.map((r) => r.name)).toEqual(['Aether-OS', 'TokenMonitorV2']);
  });

  it('sorts roots by cost descending', () => {
    const s = buildProjectsSnapshot([ev(AETHER, M / 4), ev(TOKEN, M)], probe, keyOf, 'UTC', NOW);
    expect(s.roots.map((r) => r.name)).toEqual(['TokenMonitorV2', 'Aether-OS']);
  });

  it('nests a worktree under its parent and includes it in the parent total', () => {
    const wt = `${AETHER}\\.claude\\worktrees\\statusline-feed`;
    const s = buildProjectsSnapshot([ev(AETHER, M), ev(wt, M)], probe, keyOf, 'UTC', NOW);
    expect(s.roots).toHaveLength(1);
    const root = s.roots[0];
    expect(root.name).toBe('Aether-OS');
    // 2M output tokens at the sonnet $15/Mtok rate.
    expect(root.ledger.total.usd).toBeCloseTo(30, 6);
    expect(root.children.map((c) => c.worktree)).toEqual([null, 'statusline-feed']);
  });

  // Invariant 2 from the spec: expanded rows must add up on screen.
  it('children sum exactly to their parent total', () => {
    const wt1 = `${AETHER}\\.claude\\worktrees\\a`;
    const wt2 = `${AETHER}\\.claude\\worktrees\\b`;
    const s = buildProjectsSnapshot([ev(AETHER, M), ev(wt1, M / 2), ev(wt2, M / 4)], probe, keyOf, 'UTC', NOW);
    const root = s.roots[0];
    const sum = root.children.reduce((a, c) => a + c.ledger.total.usd, 0);
    expect(sum).toBeCloseTo(root.ledger.total.usd, 10);
  });

  it('omits the children list when a repo has only its own checkout', () => {
    const s = buildProjectsSnapshot([ev(AETHER, M)], probe, keyOf, 'UTC', NOW);
    expect(s.roots[0].children).toHaveLength(1);
  });

  it('buckets unattributable events as unscoped rather than dropping them', () => {
    const s = buildProjectsSnapshot([ev('C:\\Users\\IT', M), ev(null, M)], probe, keyOf, 'UTC', NOW);
    expect(s.roots).toEqual([]);
    expect(s.unscoped!.total.usd).toBeCloseTo(30, 6);
  });

  // Invariant 1 from the spec: nothing may be silently dropped.
  it('roots plus unscoped equal the all-transcripts total', () => {
    const wt = `${AETHER}\\.claude\\worktrees\\a`;
    const events = [ev(AETHER, M), ev(wt, M), ev(TOKEN, M / 2), ev('C:\\Users\\IT', M / 4), ev(null, M / 8)];
    const s = buildProjectsSnapshot(events, probe, keyOf, 'UTC', NOW);
    const summed =
      s.roots.reduce((a, r) => a + r.ledger.total.usd, 0) + (s.unscoped?.total.usd ?? 0);
    expect(summed).toBeCloseTo(sessionLedger(events).usd, 10);
  });

  it('keeps a project with observed but zero-cost activity, at 0 rather than dropped', () => {
    const s = buildProjectsSnapshot([ev(AETHER, 0)], probe, keyOf, 'UTC', NOW);
    expect(s.roots).toHaveLength(1);
    expect(s.roots[0].ledger.total.usd).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/shared/projectsSnapshot.test.ts`
Expected: FAIL — cannot resolve `./projectsSnapshot`.

- [ ] **Step 3: Write the implementation**

```ts
// src/shared/projectsSnapshot.ts
import type { TranscriptEvent } from '../../electron/transcriptParser';
import { buildLedgerSnapshot, type LedgerSnapshot } from './ledgerMath';
import { resolveProject, type GitProbe } from './projectIdentity';

export interface ProjectNode {
  /** Opaque and stable. Never a path -- see docs/privacy-and-data.md. */
  key: string;
  /** Basename only. */
  name: string;
  worktree: string | null;
  ledger: LedgerSnapshot;
}

export interface ProjectRoot extends ProjectNode {
  /**
   * Every checkout of this repo INCLUDING its own, which carries
   * `worktree: null` and displays as "main". The root's `ledger` is built from
   * all of these events, so children sum exactly to the parent.
   */
  children: ProjectNode[];
}

export interface ProjectsSnapshot {
  /** Sorted by cost descending. */
  roots: ProjectRoot[];
  /** Events with no resolvable project. null when there were none. */
  unscoped: LedgerSnapshot | null;
  computedAtMs: number;
}

export function buildProjectsSnapshot(
  events: TranscriptEvent[],
  probe: GitProbe,
  keyOf: (repoPath: string) => string,
  timeZone: string,
  nowMs: number,
): ProjectsSnapshot {
  // repoPath -> worktree name (or '' for the repo's own checkout) -> events
  const byRepo = new Map<string, Map<string, TranscriptEvent[]>>();
  const repoNames = new Map<string, string>();
  const unscoped: TranscriptEvent[] = [];

  // Resolution is memoised per cwd: a scan holds tens of thousands of events
  // across a handful of distinct working directories.
  const cache = new Map<string, ReturnType<typeof resolveProject>>();

  for (const event of events) {
    const cwd = event.cwd ?? '';
    let ref = cache.get(cwd);
    if (!cache.has(cwd)) {
      ref = resolveProject(event.cwd, probe);
      cache.set(cwd, ref);
    }
    if (!ref) {
      unscoped.push(event);
      continue;
    }
    repoNames.set(ref.repoPath, ref.repoName);
    let checkouts = byRepo.get(ref.repoPath);
    if (!checkouts) {
      checkouts = new Map();
      byRepo.set(ref.repoPath, checkouts);
    }
    const slot = ref.worktree ?? '';
    const bucket = checkouts.get(slot);
    if (bucket) bucket.push(event);
    else checkouts.set(slot, [event]);
  }

  const roots: ProjectRoot[] = [];
  for (const [repoPath, checkouts] of byRepo) {
    const name = repoNames.get(repoPath)!;
    const children: ProjectNode[] = [];
    const allEvents: TranscriptEvent[] = [];

    for (const [slot, slotEvents] of checkouts) {
      allEvents.push(...slotEvents);
      children.push({
        key: keyOf(`${repoPath}#${slot}`),
        name,
        worktree: slot === '' ? null : slot,
        ledger: buildLedgerSnapshot(slotEvents, timeZone, nowMs),
      });
    }

    // The repo's own checkout first, then worktrees by cost descending -- so
    // "main" is a stable anchor rather than jumping position as costs move.
    children.sort((a, b) => {
      if (a.worktree === null) return -1;
      if (b.worktree === null) return 1;
      return b.ledger.total.usd - a.ledger.total.usd;
    });

    roots.push({
      key: keyOf(repoPath),
      name,
      worktree: null,
      ledger: buildLedgerSnapshot(allEvents, timeZone, nowMs),
      children,
    });
  }

  roots.sort((a, b) => b.ledger.total.usd - a.ledger.total.usd);

  return {
    roots,
    unscoped: unscoped.length > 0 ? buildLedgerSnapshot(unscoped, timeZone, nowMs) : null,
    computedAtMs: nowMs,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/shared/projectsSnapshot.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc -b`, `npm run build`. Both exit 0.

```bash
git add src/shared/projectsSnapshot.ts src/shared/projectsSnapshot.test.ts
git commit -m "feat(projects): group transcript events into a nested projects snapshot"
```

---

### Task 3: Ship the snapshot to the renderer

**Files:**
- Modify: `electron/main.ts`, `electron/preload.ts`, `src/aetherElectron.d.ts`,
  `src/state/types.ts`, `src/state/reducer.ts`, `src/state/reducer.test.ts`,
  `src/state/initialState.ts`, `src/state/persistence.ts`, `src/App.tsx`
- Create: `src/state/useProjectsSync.ts`

**Interfaces:**
- Consumes: `buildProjectsSnapshot`, `ProjectsSnapshot` (Task 2).
- Produces: `state.projectsSnapshot: ProjectsSnapshot | null`, action
  `{ type: 'SET_PROJECTS_SNAPSHOT'; snapshot: ProjectsSnapshot | null }`,
  `window.aetherElectron.projects.{onSnapshot,current}`, hook `useProjectsSync()`.

**Note:** `state.projects` (the fictional array) is left untouched by this task.
Both coexist until Task 6, so the app keeps working at every commit.

- [ ] **Step 1: Add the state slice, action and reducer case**

In `src/state/types.ts`, next to the existing `ledger` field:

```ts
import type { ProjectsSnapshot } from '../shared/projectsSnapshot';
// ...inside AetherState:
  projectsSnapshot: ProjectsSnapshot | null;
```

In `src/state/reducer.ts`, mirroring `SET_LEDGER`:

```ts
import type { ProjectsSnapshot } from '../shared/projectsSnapshot';
// action union:
  | { type: 'SET_PROJECTS_SNAPSHOT'; snapshot: ProjectsSnapshot | null }
// switch:
    case 'SET_PROJECTS_SNAPSHOT':
      return { ...state, projectsSnapshot: action.snapshot };
```

In `src/state/initialState.ts`, beside `ledger: null,`:

```ts
  projectsSnapshot: null,
```

In `src/state/persistence.ts`, add to `PERSISTENCE_EXCLUSIONS`:

```ts
  projectsSnapshot: 'per-project cost aggregates recomputed in main from the current transcript scan on every tick; a rehydrated value would show a previous machine-state\'s costs as current, the same reason `ledger` is excluded',
```

- [ ] **Step 2: Add the reducer tests and run them**

```ts
// src/state/reducer.test.ts, beside the SET_LEDGER tests
it('SET_PROJECTS_SNAPSHOT replaces projectsSnapshot wholesale', () => {
  const snapshot = { roots: [], unscoped: null, computedAtMs: 42 };
  const next = reducer(initialState, { type: 'SET_PROJECTS_SNAPSHOT', snapshot });
  expect(next.projectsSnapshot).toEqual(snapshot);
});

it('SET_PROJECTS_SNAPSHOT accepts null so a failed scan clears rather than freezes', () => {
  const seeded = reducer(initialState, {
    type: 'SET_PROJECTS_SNAPSHOT',
    snapshot: { roots: [], unscoped: null, computedAtMs: 1 },
  });
  expect(reducer(seeded, { type: 'SET_PROJECTS_SNAPSHOT', snapshot: null }).projectsSnapshot).toBeNull();
});
```

Run: `npx vitest run src/state/reducer.test.ts src/state/persistence.test.ts`
Expected: PASS. The persistence coverage test fails if the exclusion was omitted.

- [ ] **Step 3: Build and push the snapshot from main**

In `electron/main.ts`, add near the other shared-module imports:

```ts
import { buildProjectsSnapshot, type ProjectsSnapshot } from '../src/shared/projectsSnapshot';
import { normalizePath, type GitProbe } from '../src/shared/projectIdentity';
import { createHash } from 'node:crypto';
```

Beside `cachedLedgerSnapshot`:

```ts
let cachedProjectsSnapshot: ProjectsSnapshot | null = null;

// Memoised for the process lifetime: repo roots do not move, and this is called
// once per distinct cwd per scan rather than once per event.
const gitProbeCache = new Map<string, boolean>();
const gitProbe: GitProbe = (dir) => {
  const cached = gitProbeCache.get(dir);
  if (cached !== undefined) return cached;
  const exists = existsSync(join(dir, '.git'));
  gitProbeCache.set(dir, exists);
  return exists;
};

// Paths must not cross IPC (docs/privacy-and-data.md). Hashing happens here,
// the only place a path is allowed, rather than in the shared resolver -- which
// carries no node: import so it can never reach the renderer bundle.
const projectKey = (repoPath: string): string =>
  createHash('sha256').update(normalizePath(repoPath)).digest('hex').slice(0, 12);
```

Immediately after the existing `sendToWindow('ledger:snapshot', ...)` block, reusing
the same `optimizeEvents` array and the same zone and clock:

```ts
  cachedProjectsSnapshot = buildProjectsSnapshot(
    optimizeEvents,
    gitProbe,
    projectKey,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    Date.now(),
  );
  sendToWindow('projects:snapshot', cachedProjectsSnapshot);
```

Beside the `ledger:snapshot:current` handler:

```ts
ipcMain.handle('projects:snapshot:current', () => cachedProjectsSnapshot);
```

- [ ] **Step 4: Expose the channel**

`electron/preload.ts` — beside the `ledger` block:

```ts
import type { ProjectsSnapshot } from '../src/shared/projectsSnapshot';
// ...
  projects: {
    onSnapshot: (callback: (snapshot: ProjectsSnapshot | null) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: ProjectsSnapshot | null) => callback(snapshot);
      ipcRenderer.on('projects:snapshot', listener);
      return () => ipcRenderer.removeListener('projects:snapshot', listener);
    },
    current: (): Promise<ProjectsSnapshot | null> => ipcRenderer.invoke('projects:snapshot:current'),
  },
```

`src/aetherElectron.d.ts` — beside the `ledger` entry:

```ts
import type { ProjectsSnapshot } from './shared/projectsSnapshot';
// ...
      projects: {
        onSnapshot: (callback: (snapshot: ProjectsSnapshot | null) => void) => () => void;
        current: () => Promise<ProjectsSnapshot | null>;
      };
```

- [ ] **Step 5: Add the sync hook and mount it**

```ts
// src/state/useProjectsSync.ts
import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useProjectsSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const projects = window.aetherElectron?.projects;
    if (!projects) return;

    // Pull what main already has before subscribing: the first scan can finish
    // before this listener exists, and the interval is 60s. Same race and same
    // fix as useLedgerSync.
    let cancelled = false;
    projects
      .current()
      .then((snapshot) => {
        if (!cancelled && snapshot) dispatch({ type: 'SET_PROJECTS_SNAPSHOT', snapshot });
      })
      .catch(() => {
        // Older main process without the pull channel; the push still works.
      });

    const unsubscribe = projects.onSnapshot((snapshot) => {
      cancelled = true;
      dispatch({ type: 'SET_PROJECTS_SNAPSHOT', snapshot });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [dispatch]);
}
```

In `src/App.tsx`, mirroring `LedgerSync`: add the import, add `<ProjectsSync />`
beside `<LedgerSync />`, and add the wrapper component:

```tsx
function ProjectsSync() {
  useProjectsSync();
  return null;
}
```

- [ ] **Step 6: Verify and commit**

Run: `npx tsc -b`, `npx vitest run`, `npm run build`, `npm run electron:build`.
All exit 0.

```bash
git add electron/main.ts electron/preload.ts src/aetherElectron.d.ts src/state src/App.tsx
git commit -m "feat(projects): push a per-project cost snapshot from main to the renderer"
```

---

### Task 4: The nested roster

**Files:**
- Rewrite: `src/components/projects/ProjectRosterCard.tsx`
- Create: `src/components/projects/ProjectRosterCard.test.tsx` (replacing the existing one)

**Interfaces:**
- Consumes: `ProjectsSnapshot`, `ProjectRoot`, `ProjectNode` (Task 2);
  `usdPrecise` from `../ledger/format`; `useColors`, `Button`.
- Produces: `<ProjectRosterCard snapshot={...} selectedKey={...} onSelect={(key) => void} />`.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/projects/ProjectRosterCard.test.tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render as rtlRender, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AetherStoreProvider } from '../../state/store';
import { ProjectRosterCard } from './ProjectRosterCard';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';

function render(ui: ReactNode) {
  return rtlRender(<AetherStoreProvider>{ui}</AetherStoreProvider>);
}
// No Vitest globals in this suite, so RTL never registers its own cleanup.
afterEach(cleanup);

const ledger = (usd: number) =>
  ({
    total: { usd, breakdown: { input: usd, output: 0, cacheCreation: 0, cacheRead: 0 } },
    tiers: ['sonnet' as const],
    rollups: { today: usd, week: usd, month: usd },
    cache: { cacheReadTokens: 0, wouldHaveCostUsd: 0, actuallyCostUsd: 0, savedUsd: 0 },
    cacheHitRate: 0,
    timeZone: 'UTC',
    computedAtMs: 0,
  });

const snapshot: ProjectsSnapshot = {
  roots: [
    {
      key: 'aether', name: 'Aether-OS', worktree: null, ledger: ledger(184.2),
      children: [
        { key: 'aether-main', name: 'Aether-OS', worktree: null, ledger: ledger(31.05) },
        { key: 'aether-wt', name: 'Aether-OS', worktree: 'statusline-feed', ledger: ledger(153.15) },
      ],
    },
    { key: 'tmv2', name: 'TokenMonitorV2', worktree: null, ledger: ledger(96.4), children: [
      { key: 'tmv2-main', name: 'TokenMonitorV2', worktree: null, ledger: ledger(96.4) },
    ] },
  ],
  unscoped: ledger(44.9),
  computedAtMs: 0,
};

describe('ProjectRosterCard', () => {
  it('lists roots with their combined cost', () => {
    render(<ProjectRosterCard snapshot={snapshot} selectedKey={null} onSelect={() => {}} />);
    expect(screen.getByText('Aether-OS')).toBeTruthy();
    expect(screen.getByText('$184.20')).toBeTruthy();
    expect(screen.getByText('$96.40')).toBeTruthy();
  });

  it('hides worktree children until the root is expanded', () => {
    render(<ProjectRosterCard snapshot={snapshot} selectedKey={null} onSelect={() => {}} />);
    expect(screen.queryByText('statusline-feed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /expand Aether-OS/i }));
    expect(screen.getByText('statusline-feed')).toBeTruthy();
    expect(screen.getByText('main')).toBeTruthy();
  });

  it('offers no disclosure control for a repo with only its own checkout', () => {
    render(<ProjectRosterCard snapshot={snapshot} selectedKey={null} onSelect={() => {}} />);
    expect(screen.queryByRole('button', { name: /expand TokenMonitorV2/i })).toBeNull();
  });

  it('renders the unscoped bucket, and does not call it a project', () => {
    render(<ProjectRosterCard snapshot={snapshot} selectedKey={null} onSelect={() => {}} />);
    expect(screen.getByText(/unscoped/i)).toBeTruthy();
    expect(screen.getByText('$44.90')).toBeTruthy();
  });

  it('omits the unscoped row entirely when there is nothing unattributable', () => {
    render(<ProjectRosterCard snapshot={{ ...snapshot, unscoped: null }} selectedKey={null} onSelect={() => {}} />);
    expect(screen.queryByText(/unscoped/i)).toBeNull();
  });

  it('reports the clicked key', () => {
    const onSelect = vi.fn();
    render(<ProjectRosterCard snapshot={snapshot} selectedKey={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('TokenMonitorV2'));
    expect(onSelect).toHaveBeenCalledWith('tmv2');
  });

  it('says so plainly when no projects have been observed', () => {
    render(<ProjectRosterCard snapshot={{ roots: [], unscoped: null, computedAtMs: 0 }} selectedKey={null} onSelect={() => {}} />);
    expect(screen.getByText(/no projects observed/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/projects/ProjectRosterCard.test.tsx`
Expected: FAIL — the component does not accept these props.

- [ ] **Step 3: Rewrite the component**

Replace `ProjectRosterCard.tsx` entirely:

```tsx
import { useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { usdPrecise } from '../ledger/format';
import type { ProjectNode, ProjectsSnapshot } from '../../shared/projectsSnapshot';

export function ProjectRosterCard({
  snapshot,
  selectedKey,
  onSelect,
}: {
  snapshot: ProjectsSnapshot | null;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const colors = useColors();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (!snapshot || snapshot.roots.length === 0) {
    return (
      <div style={cardStyle(colors)}>
        <div style={titleStyle(colors)}>PROJECTS</div>
        <div style={emptyStyle(colors)}>No projects observed yet.</div>
      </div>
    );
  }

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>PROJECTS</div>

      {snapshot.roots.map((root) => {
        // Only offer disclosure when there is genuinely more than one checkout;
        // otherwise the single child is identical to its parent.
        const expandable = root.children.length > 1;
        const isOpen = expanded.has(root.key);
        return (
          <div key={root.key}>
            <div style={rowStyle(colors, root.key === selectedKey)}>
              {expandable ? (
                <Button
                  onClick={() => toggle(root.key)}
                  style={caretStyle(colors)}
                  aria-label={`expand ${root.name}`}
                >
                  {isOpen ? '▾' : '▸'}
                </Button>
              ) : (
                <span style={caretSpacerStyle} />
              )}
              <Button onClick={() => onSelect(root.key)} style={nameStyle(colors)}>
                {root.name}
              </Button>
              <span style={costStyle(colors)}>{usdPrecise(root.ledger.total.usd)}</span>
            </div>

            {expandable &&
              isOpen &&
              root.children.map((child) => (
                <div key={child.key} style={childRowStyle(colors, child.key === selectedKey)}>
                  <Button onClick={() => onSelect(child.key)} style={childNameStyle(colors)}>
                    {child.worktree === null ? 'main' : child.worktree}
                  </Button>
                  <span style={costStyle(colors)}>{usdPrecise(child.ledger.total.usd)}</span>
                </div>
              ))}
          </div>
        );
      })}

      {snapshot.unscoped && (
        <div style={rowStyle(colors, false)}>
          <span style={caretSpacerStyle} />
          <span
            style={unscopedNameStyle(colors)}
            title="Work done outside any git repository — most often from the home directory. Not an error."
          >
            unscoped — work outside any git repository
          </span>
          <span style={costStyle(colors)}>{usdPrecise(snapshot.unscoped.total.usd)}</span>
        </div>
      )}
    </div>
  );
}
```

Style functions follow the repo convention: each takes `colors: ColorPalette`
as its first parameter, uses `fonts.ui` / `fonts.mono`, and the selected row
uses `colors.activeBorder` to match the sidebar's active-item treatment.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/projects/ProjectRosterCard.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc -b`, `npm run build`.

```bash
git add src/components/projects/ProjectRosterCard.tsx src/components/projects/ProjectRosterCard.test.tsx
git commit -m "feat(projects): nested project roster with per-repo cost"
```

---

### Task 5: The detail panel, and wiring the view

**Files:**
- Rewrite: `src/components/projects/ProjectDetailCard.tsx`,
  `src/components/projects/ProjectsView.tsx`,
  `src/components/projects/projectsMath.ts`,
  `src/components/projects/projectsMath.test.ts`
- Create: `src/components/projects/ProjectDetailCard.test.tsx`

**Interfaces:**
- Consumes: `SessionCostCard`, `RollupCard`, `CacheImpactCard` from
  `../ledger/*`; `ProjectRoot`/`ProjectNode` (Task 2).
- Produces: `findProjectByKey(snapshot, key): ProjectNode | null` in
  `projectsMath.ts`; `<ProjectDetailCard node={...} />`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/components/projects/projectsMath.test.ts -- replaces the fictional tests
import { describe, it, expect } from 'vitest';
import { findProjectByKey } from './projectsMath';
// (reuse the `snapshot` fixture shape from ProjectRosterCard.test.tsx)

describe('findProjectByKey', () => {
  it('finds a root', () => {
    expect(findProjectByKey(snapshot, 'tmv2')?.name).toBe('TokenMonitorV2');
  });

  it('finds a nested worktree child', () => {
    expect(findProjectByKey(snapshot, 'aether-wt')?.worktree).toBe('statusline-feed');
  });

  // A persisted selection can outlive the project it named.
  it('returns null for a key absent from the snapshot', () => {
    expect(findProjectByKey(snapshot, 'deleted-project')).toBeNull();
  });

  it('returns null for a null snapshot or null key', () => {
    expect(findProjectByKey(null, 'aether')).toBeNull();
    expect(findProjectByKey(snapshot, null)).toBeNull();
  });

  it('defaults to the highest-cost root when nothing is selected', () => {
    expect(findProjectByKey(snapshot, null, { fallbackToFirst: true })?.name).toBe('Aether-OS');
  });
});
```

```tsx
// src/components/projects/ProjectDetailCard.test.tsx
it('shows the project name, its cost breakdown and its rollup', () => {
  render(<ProjectDetailCard node={snapshot.roots[0]} />);
  expect(screen.getByText(/Aether-OS/)).toBeTruthy();
  expect(screen.getByText('$184.20')).toBeTruthy();
});

it('labels a worktree node with its worktree name', () => {
  render(<ProjectDetailCard node={snapshot.roots[0].children[1]} />);
  expect(screen.getByText(/statusline-feed/)).toBeTruthy();
});

it('prompts for a selection when none is made', () => {
  render(<ProjectDetailCard node={null} />);
  expect(screen.getByText(/select a project/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/projects/`
Expected: FAIL — `findProjectByKey` undefined; `ProjectDetailCard` prop mismatch.

- [ ] **Step 3: Implement**

`projectsMath.ts` is reduced to `findProjectByKey` alone — `STATUS_COLOR`,
`STATUS_ORDER`, `groupProjectsByStatus`, `computeLiveProjectPct` and
`pickSelectedProject` all describe fictional data and are deleted:

```ts
import type { ProjectNode, ProjectsSnapshot } from '../../shared/projectsSnapshot';

export function findProjectByKey(
  snapshot: ProjectsSnapshot | null,
  key: string | null,
  opts: { fallbackToFirst?: boolean } = {},
): ProjectNode | null {
  if (!snapshot) return null;
  if (key) {
    for (const root of snapshot.roots) {
      if (root.key === key) return root;
      const child = root.children.find((c) => c.key === key);
      if (child) return child;
    }
  }
  // A persisted key can name a project that no longer exists; fall through
  // rather than stranding the panel on nothing.
  return opts.fallbackToFirst ? snapshot.roots[0] ?? null : null;
}
```

```tsx
// src/components/projects/ProjectDetailCard.tsx
import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { SessionCostCard } from '../ledger/SessionCostCard';
import { RollupCard } from '../ledger/RollupCard';
import { CacheImpactCard } from '../ledger/CacheImpactCard';
import type { ProjectNode } from '../../shared/projectsSnapshot';

export function ProjectDetailCard({ node }: { node: ProjectNode | null }) {
  const colors = useColors();
  if (!node) return <div style={emptyStyle(colors)}>Select a project to see its cost.</div>;

  return (
    <div style={rootStyle}>
      <div style={headerStyle(colors)}>
        {node.name}
        {node.worktree !== null && <span style={wtStyle(colors)}>worktree: {node.worktree}</span>}
      </div>
      <SessionCostCard total={node.ledger.total} tiers={node.ledger.tiers} />
      <RollupCard rollups={node.ledger.rollups} />
      <CacheImpactCard cache={node.ledger.cache} hitRatio={node.ledger.cacheHitRate} />
    </div>
  );
}
```

```tsx
// src/components/projects/ProjectsView.tsx
import type { CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { findProjectByKey } from './projectsMath';
import { ProjectRosterCard } from './ProjectRosterCard';
import { ProjectDetailCard } from './ProjectDetailCard';

export function ProjectsView() {
  const { state, dispatch } = useAetherStore();
  const snapshot = state.projectsSnapshot;
  // A persisted key can name a project that no longer exists, so fall back to
  // the highest-cost root rather than stranding the panel on nothing.
  const selected = findProjectByKey(snapshot, state.selectedProject, { fallbackToFirst: true });

  return (
    <div style={rootStyle}>
      <ProjectRosterCard
        snapshot={snapshot}
        selectedKey={selected?.key ?? null}
        onSelect={(key) => dispatch({ type: 'SELECT_PROJECT', key })}
      />
      <ProjectDetailCard node={selected} />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
```

**Rename the action payload.** `SELECT_PROJECT` currently carries
`{ name: string }`, which held a fictional project's display name. It now
carries an opaque key, and calling that field `name` would actively mislead —
the value is a hash, and several nodes share a `name`. In `reducer.ts` change
the action to `{ type: 'SELECT_PROJECT'; key: string }` and the case to
`return { ...state, selectedProject: action.key };`, then update the existing
`SELECT_PROJECT` test in `reducer.test.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/projects/`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc -b`, `npm run build`.

```bash
git add src/components/projects
git commit -m "feat(projects): per-project cost detail composed from the Ledger cards"
```

---

### Task 6: Remove the fictional projects

**Files:**
- Modify: `src/state/types.ts`, `src/state/initialState.ts`, `src/state/reducer.ts`,
  `src/state/reducer.test.ts`, `src/state/persistence.ts`,
  `src/components/dashboard/ProjectsDigest.tsx`,
  `src/components/dashboard/ReactorStatusCard.tsx`

**Interfaces:** removes `ProjectStub`, `ProjectStatus`, `state.projects`, and the
`NEW_PROJECT` action. Nothing produced.

**Two consumers the spec did not list, found while planning** — both must be
handled in this task or the build breaks:
`ProjectsDigest.tsx` (a Dashboard card rendering the fictional projects) and
`ReactorStatusCard.tsx:125` (a "New Project" button dispatching `NEW_PROJECT`).

- [ ] **Step 1: Rewrite ProjectsDigest against real data**

`roots` is already cost-descending, so "top three" is a slice. Status badges and
`computeLiveProjectPct` are dropped — neither has a real equivalent, and
inventing one is exactly what this stage removes.

```tsx
// src/components/dashboard/ProjectsDigest.tsx
import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { useAetherStore } from '../../state/store';
import { usdPrecise } from '../ledger/format';

export function ProjectsDigest() {
  const colors = useColors();
  const { state } = useAetherStore();
  const top = state.projectsSnapshot?.roots.slice(0, 3) ?? [];

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>PROJECTS</div>
      {top.length === 0 ? (
        <div style={emptyStyle(colors)}>No projects observed yet.</div>
      ) : (
        top.map((p) => (
          <div key={p.key} style={rowStyle}>
            <span style={nameStyle(colors)}>{p.name}</span>
            <span style={costStyle(colors)}>{usdPrecise(p.ledger.total.usd)}</span>
          </div>
        ))
      )}
    </div>
  );
}
```

Keep the existing card chrome (`cardStyle`/`titleStyle`) from the current file so
the Dashboard's visual rhythm is unchanged; only the row contents differ.

- [ ] **Step 2: Remove the New Project button**

Delete the `Button` at `ReactorStatusCard.tsx:125` and its `NEW_PROJECT` dispatch.
There is no real "create a project" action — a project exists because you worked
in it.

- [ ] **Step 3: Delete the fictional model**

- `src/state/types.ts`: delete `ProjectStatus`, `ProjectStub`, and the
  `projects: ProjectStub[]` field.
- `src/state/initialState.ts`: delete the four stubs.
- `src/state/reducer.ts`: delete the `NEW_PROJECT` action member and its `case`,
  including the name pool and hue cycling.
- `src/state/persistence.ts`: remove `projects: state.projects` from the
  persisted slice.
- `src/state/reducer.test.ts`: delete both `NEW_PROJECT` tests.

- [ ] **Step 4: Run the full suite**

Run: `npx tsc -b`, `npx vitest run`, `npm run build`, `npm run electron:build`.
Expected: all exit 0, and no test references `ProjectStub`.

- [ ] **Step 5: Commit**

```bash
git add src/state src/components/dashboard
git commit -m "refactor(projects): delete the fictional project stubs and NEW_PROJECT"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md`, `docs/roadmap.md`, `README.md`, `PROGRESS.md`

- [ ] **Step 1: CLAUDE.md** — add `projectIdentity.ts` and `projectsSnapshot.ts`
  to the `shared/` list. Add a convention note: **project identity resolves from
  the path string before any filesystem probe**, with the reason (history
  references deleted worktrees), and **no absolute path crosses IPC**.

- [ ] **Step 2: docs/roadmap.md** — Stage 16 row in the established table format,
  naming that this retires the last major fictional data source and that the
  app-wide scope switch is the follow-on.

- [ ] **Step 3: README.md** — update the Projects bullet: real projects, cost per
  project, worktrees nested under their repo.

- [ ] **Step 4: PROGRESS.md** — entry in the established format stating plainly:
  (a) the directory layout does not match the project list and why `cwd` is the
  signal; (b) worktree identity is path-derived so deleted checkouts stay
  attributable; (c) `unscoped` is expected to be large and is not an error state;
  (d) attribution follows `cwd`, not intent; (e) whether the visual layer was
  verified in a running window.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/roadmap.md README.md PROGRESS.md
git commit -m "docs: record the Stage 16 real Projects view"
```

---

After all seven tasks: whole-branch review. Four questions the reviewer must
answer explicitly:

1. **Can any absolute path reach the renderer, the store, or localStorage?**
   Answer by reading the IPC payload construction, not by trusting the types.
2. **Does every event land somewhere?** Roots plus `unscoped` must equal the
   all-transcripts Ledger total. Verify the test exists and is not vacuous.
3. **Do a root's children sum to the root?** Including on a repo with no
   worktrees, where the single child must equal its parent exactly.
4. **Does any surface still present invented data as real?** `pct`, `crew`,
   `status`, and the New Project button were all fictional; confirm none
   survives anywhere, including on the Dashboard.
