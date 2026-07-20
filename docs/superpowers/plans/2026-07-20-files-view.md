# Files View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Files view — a fleet-wide, agent-grouped roster of every real file any agent has touched, replacing the current "coming soon" placeholder.

**Architecture:** One new pure function (`groupFilesByAgent`) derives agent-grouped file sections from `state.agents`; one new presentational component (`FilesView`) renders them as a single full-width card with click-to-navigate-to-Agents rows; one line in `viewRegistry.ts` wires it in. No new state, reducer action, or persistence entry — the smallest-scoped view since Uplinks.

**Tech Stack:** Vite + React 18 + TypeScript (strict), Vitest, inline `CSSProperties` styling (no CSS-in-JS library), classic script-style components.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-20-files-view-design.md` (commit `a0ba193`) — every requirement below is copied verbatim from it.
- `AgentFile`'s existing shape (`{ s: string; n: string; c: string }`) is reused as-is — no new type.
- Placeholder file names to filter, exact strings: `'booting runtime…'` and `'awaiting mission'` (note: `…` is the single Unicode ellipsis character, not three periods — copy exactly from `commands.ts`'s `makeAgent()`).
- An agent left with zero real files after filtering must be **excluded entirely** from the grouped result (not included with an empty `files: []`).
- No new state field, reducer action, or `persistence.ts` whitelist entry — this plan touches zero files under `src/state/`.
- File-row click dispatches exactly two actions in order: `{ type: 'SELECT_AGENT', name: <agent.name> }` then `{ type: 'SET_ACTIVE_TAB', tab: 'Agents' }` — matching `GridView.tsx`'s existing project-click pattern.
- `viewRegistry.ts`'s `Files` entry keeps its existing `inTopBar: true, inSidebar: false` — only its `component` field changes.
- Baseline before this plan: 266 passing tests across 25 files, clean `tsc -b`, clean `npm run build`, working tree clean at commit `a0ba193` (the spec commit).

---

### Task 1: `groupFilesByAgent` pure function

**Files:**
- Create: `src/components/files/filesMath.ts`
- Test: `src/components/files/filesMath.test.ts`

**Interfaces:**
- Consumes: `Agent`, `AgentFile` types from `src/state/types.ts` (existing, unchanged).
- Produces: `groupFilesByAgent(agents: Agent[]): { name: string; i: string; hue: string; files: AgentFile[] }[]` — consumed by Task 2's `FilesView.tsx`. `i` is each agent's existing avatar-code field (e.g. `'CB'` for Code Builder), reused here rather than deriving initials from `name` — matching `AgentDetailCard.tsx`'s existing `{agent.i}` avatar convention.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import type { Agent } from '../../state/types';
import { groupFilesByAgent } from './filesMath';

function makeTestAgent(overrides: Partial<Agent>): Agent {
  return {
    i: 'AB',
    name: 'Test Agent',
    task: 'testing',
    pct: 50,
    hue: '#7ef0ff',
    eta: '1m',
    share: 10,
    hist: [1, 2, 3],
    files: [],
    ...overrides,
  };
}

describe('groupFilesByAgent', () => {
  it('filters out both placeholder file names, keeping only real files', () => {
    const agents = [
      makeTestAgent({
        name: 'Code Builder',
        i: 'CB',
        files: [
          { s: '✓', n: 'routes/auth.js', c: '#3be0a0' },
          { s: '›', n: 'booting runtime…', c: '#4e7c8b' },
          { s: '·', n: 'awaiting mission', c: '#4e7c8b' },
        ],
      }),
    ];
    const result = groupFilesByAgent(agents);
    expect(result).toHaveLength(1);
    expect(result[0].i).toBe('CB');
    expect(result[0].files).toEqual([{ s: '✓', n: 'routes/auth.js', c: '#3be0a0' }]);
  });

  it('excludes an agent entirely when all its files are placeholders', () => {
    const agents = [
      makeTestAgent({
        name: 'Fresh Agent',
        files: [
          { s: '›', n: 'booting runtime…', c: '#4e7c8b' },
          { s: '·', n: 'awaiting mission', c: '#4e7c8b' },
        ],
      }),
    ];
    expect(groupFilesByAgent(agents)).toEqual([]);
  });

  it('preserves file order within an agent (no re-sorting)', () => {
    const agents = [
      makeTestAgent({
        name: 'Doc Writer',
        files: [
          { s: '✓', n: 'docs/api.md', c: '#3be0a0' },
          { s: '›', n: 'docs/setup.md', c: '#4e7c8b' },
        ],
      }),
    ];
    const result = groupFilesByAgent(agents);
    expect(result[0].files.map((f) => f.n)).toEqual(['docs/api.md', 'docs/setup.md']);
  });

  it('does not mutate the input agents array or its nested objects', () => {
    const original = [
      makeTestAgent({
        name: 'Test Runner',
        files: [
          { s: '✓', n: 'tests/auth.spec.ts', c: '#3be0a0' },
          { s: '·', n: 'awaiting mission', c: '#4e7c8b' },
        ],
      }),
    ];
    const snapshot = JSON.parse(JSON.stringify(original));
    groupFilesByAgent(original);
    expect(original).toEqual(snapshot);
  });

  it('includes multiple agents with real files, each carrying its own name, code, and hue', () => {
    const agents = [
      makeTestAgent({ name: 'Code Builder', i: 'CB', hue: '#7ef0ff', files: [{ s: '✓', n: 'routes/auth.js', c: '#3be0a0' }] }),
      makeTestAgent({ name: 'Database Agent', i: 'DB', hue: '#8ab6ff', files: [{ s: '›', n: 'migrations/0043.sql', c: '#4e7c8b' }] }),
    ];
    const result = groupFilesByAgent(agents);
    expect(result).toEqual([
      { name: 'Code Builder', i: 'CB', hue: '#7ef0ff', files: [{ s: '✓', n: 'routes/auth.js', c: '#3be0a0' }] },
      { name: 'Database Agent', i: 'DB', hue: '#8ab6ff', files: [{ s: '›', n: 'migrations/0043.sql', c: '#4e7c8b' }] },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/files/filesMath.test.ts`
Expected: FAIL — `Cannot find module './filesMath'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```ts
import type { Agent, AgentFile } from '../../state/types';

const PLACEHOLDER_FILE_NAMES = new Set(['booting runtime…', 'awaiting mission']);

export function groupFilesByAgent(agents: Agent[]): { name: string; i: string; hue: string; files: AgentFile[] }[] {
  return agents
    .map((a) => ({ name: a.name, i: a.i, hue: a.hue, files: a.files.filter((f) => !PLACEHOLDER_FILE_NAMES.has(f.n)) }))
    .filter((g) => g.files.length > 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/files/filesMath.test.ts`
Expected: PASS, 5/5 tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npx tsc -b`
Expected: 271/271 tests passing (266 + 5 new), 26 files, 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/files/filesMath.ts src/components/files/filesMath.test.ts
git commit -m "feat: add groupFilesByAgent to derive the fleet-wide files roster"
```

---

### Task 2: `FilesView` component + registry wiring

**Files:**
- Create: `src/components/files/FilesView.tsx`
- Modify: `src/viewRegistry.ts`
- Modify: `src/viewRegistry.test.ts`

**Interfaces:**
- Consumes: `groupFilesByAgent` from Task 1 (`./filesMath`), `useAetherStore` (existing hook, `src/state/store.ts`), `colors`/`fonts` from `src/styles/tokens.ts`.
- Produces: `FilesView` component, registered in `viewRegistry.ts`'s `VIEWS` array as the `Files` entry's `component`.

- [ ] **Step 1: Write the failing registry test**

In `src/viewRegistry.test.ts`, add this test after the `'getViewComponent resolves Uplinks now that it is built'` test (the last one in the file, before the closing `});`):

```ts
  it('getViewComponent resolves Files now that it is built', () => {
    expect(getViewComponent('Files')).not.toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/viewRegistry.test.ts`
Expected: FAIL — `getViewComponent('Files')` returns `null` (still wired to `null` in `viewRegistry.ts`).

- [ ] **Step 3: Write `FilesView.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { groupFilesByAgent } from './filesMath';

export function FilesView() {
  const { state, dispatch } = useAetherStore();
  const groups = groupFilesByAgent(state.agents);

  const openAgent = (name: string) => {
    dispatch({ type: 'SELECT_AGENT', name });
    dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Agents' });
  };

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>FILES</div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {groups.map((g) => (
          <div key={g.name}>
            <div style={groupHeaderStyle}>
              <span style={avatarStyle(g.hue)}>{g.i}</span>
              <span style={{ font: `700 13px/1 ${fonts.ui}`, color: colors.textPrimary }}>{g.name}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, marginLeft: 34 }}>
              {g.files.map((f, idx) => (
                <div key={idx} onClick={() => openAgent(g.name)} style={rowStyle}>
                  <span style={{ color: f.c, flex: 'none', font: `400 12px/1.5 ${fonts.mono}` }}>{f.s}</span>
                  <span style={{ color: colors.textSecondary, font: `400 12px/1.5 ${fonts.mono}` }}>{f.n}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        {!groups.length && <div style={emptyStyle}>no files touched yet — spawn an agent to see its work appear here</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  padding: 18,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
};
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const groupHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
function avatarStyle(hue: string): CSSProperties {
  return {
    width: 24,
    height: 24,
    flex: 'none',
    borderRadius: 6,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 5px,#123f4e 5px 10px)',
    border: `1px solid ${hue}`,
    display: 'grid',
    placeItems: 'center',
    font: `700 10px/1 ${fonts.mono}`,
    color: hue,
  };
}
const rowStyle: CSSProperties = { display: 'flex', gap: 8, cursor: 'pointer' };
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
```

- [ ] **Step 4: Wire it into `viewRegistry.ts`**

Add the import (after the `UplinksView` import, keeping the existing alphabetical-by-view-order convention of this file):

```ts
import { FilesView } from './components/files/FilesView';
```

Change the `Files` entry (currently `{ id: 'Files', inTopBar: true, inSidebar: false, component: null }`) to:

```ts
  { id: 'Files', inTopBar: true, inSidebar: false, component: FilesView },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/viewRegistry.test.ts`
Expected: PASS, all tests in the file green.

- [ ] **Step 6: Run the full suite, typecheck, and build**

Run: `npm test && npx tsc -b && npm run build`
Expected: 272/272 tests passing (271 + 1 new), 26 files, 0 type errors, build succeeds.

- [ ] **Step 7: Manual dev-server visual check**

Run: `npm run dev`, open the app, click the **Files** tab in the top bar. Confirm:
- Every seeded agent with real files renders as its own section (name + colored avatar initial), with its files listed below in the same order as `initialState.ts`'s seed data.
- No agent shows `'booting runtime…'` or `'awaiting mission'` as a file.
- Clicking any file row navigates to the Agents tab with that exact agent selected.

- [ ] **Step 8: Commit**

```bash
git add src/components/files/FilesView.tsx src/viewRegistry.ts src/viewRegistry.test.ts
git commit -m "feat: build the Files view as a fleet-wide, agent-grouped file roster"
```

---

### Task 3: Final integration QA

**Files:** None (verification only).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: 272/272 tests, 26 files, 0 type errors, build succeeds.

- [ ] **Step 2: Manual GUI QA checklist**

Using the running dev server:
1. Files view renders every seeded agent with real files, correctly grouped, with accurate status-glyph colors and paths.
2. Spawn a new agent via Terminal (`spawn <name>`) — confirm it does **not** appear anywhere in Files (its files are only the two placeholder strings).
3. Click a file row — confirm navigation to Agents with the correct agent selected.
4. Reload the page — Files still renders identically (no persistence gap, since nothing new was added to the whitelist).
5. Confirm no regressions: Agents' own FILES section on `AgentDetailCard`, Grid's project-click navigation, and every other already-shipped view still work.

- [ ] **Step 3: Report results**

No commit for this task (verification only) unless a regression is found, in which case fix it, re-run Steps 1-2, and commit the fix separately.
