# Files View — Design

## Context

"Files" is the last remaining unbuilt nav tab (`viewRegistry.ts:29` currently has
`{ id: 'Files', inTopBar: true, inSidebar: false, component: null }`, rendering a
generic "coming soon" panel). A full grep of `src/` before writing this spec found
that a "files" data model already exists, but scoped to *agent activity*, not a
real filesystem:

- `AgentFile` (`types.ts`): `{ s: string; n: string; c: string }` — a status glyph,
  a path-like name, and a color.
- Every `Agent` carries `files: AgentFile[]` (`types.ts`), seeded with realistic
  paths per agent in `initialState.ts` (e.g. Code Builder → `routes/auth.js`,
  `middleware/session.js`).
- `AgentDetailCard.tsx` already renders a per-agent "FILES" section from this data.
- Chat's `personas.ts`, `localResponder.ts`, and `systemPrompt.ts` all reference
  `agent.files` for in-character replies about file activity.
- `makeAgent()` (`commands.ts`) seeds newly-spawned agents with two placeholder
  entries — `'booting runtime…'` and `'awaiting mission'` — that are not real paths.

No directory tree, file content, or per-project file list exists anywhere in this
app. `ProjectStub` has no file/artifact field at all.

## Goal

Surface the existing per-agent file data as its own fleet-wide view: every real
file any agent has touched, grouped by the agent that touched it, with each file
clickable to jump to that agent's own detail view.

## Non-goals

- **No browsable file/directory tree or file-content viewer.** Nothing in this app
  models real file content or folder structure; inventing one would be scope far
  beyond what any existing data supports.
- **No per-project grouping.** `ProjectStub` has no file/artifact field and `crew`
  is just names, not references back to `Agent` objects — regrouping by project
  would require new plumbing this view doesn't need.
- **No aggregate stats card.** Just the agent-grouped roster, full width — the
  underlying data (a handful of files per agent) doesn't call for a second card.
- **No new state, reducer action, or persistence entry.** This view is a pure
  derivation of `state.agents`, already fully persisted.

## Architecture

### `groupFilesByAgent` (new, in `src/components/files/filesMath.ts`)

```ts
import type { Agent, AgentFile } from '../../state/types';

const PLACEHOLDER_FILE_NAMES = new Set(['booting runtime…', 'awaiting mission']);

export function groupFilesByAgent(agents: Agent[]): { name: string; hue: string; files: AgentFile[] }[] {
  return agents
    .map((a) => ({ name: a.name, hue: a.hue, files: a.files.filter((f) => !PLACEHOLDER_FILE_NAMES.has(f.n)) }))
    .filter((g) => g.files.length > 0);
}
```

The only new logic in this feature. Filters out `makeAgent()`'s two placeholder
strings (matching this spec's Non-goals: a files roster showing "booting
runtime…" next to a real path would read as noise, not a real file) and drops
any agent left with zero real files after filtering — a freshly-spawned agent
with only placeholder entries doesn't appear in Files until it has real files.
Preserves each agent's own file order (no re-sorting) and does not mutate the
input array or its nested objects.

### `FilesView.tsx` (new, in `src/components/files/`)

A single full-width card — no master-detail split, matching Uplinks' and
Settings' single-card precedent rather than Agents/Projects/Memory's roster+detail
split (there's no second panel's worth of content here; `AgentFile`'s shape is
too small to justify its own detail card). Structure mirrors
`MemoryRosterCard.tsx`'s grouped-sections pattern:

- Card title `FILES`.
- One section per agent returned by `groupFilesByAgent(state.agents)`: a header
  row (small hue-colored avatar-style initial + agent name, matching
  `AgentDetailCard`'s avatar styling) followed by that agent's file rows
  (status glyph in `f.c`, path in `f.n` — same two-span layout
  `AgentDetailCard`'s own FILES section already uses).
- Each file row is clickable: `onClick` dispatches `{ type: 'SELECT_AGENT', name: agent.name }`
  then `{ type: 'SET_ACTIVE_TAB', tab: 'Agents' }` — the same two-dispatch
  navigation `GridView.tsx` already uses for its project-node clicks.
- Empty state (no agents, or every agent's files are all-placeholder): a single
  centered message, matching `MemoryRosterCard`'s `!state.memories.length`
  empty-state convention — text: "no files touched yet — spawn an agent to see
  its work appear here".

### `viewRegistry.ts`

One-line change: the existing `Files` entry's `component: null` becomes
`component: FilesView`. No other field changes — it's already
`inTopBar: true, inSidebar: false`, matching every other top-bar-only view.

## Data flow

`state.agents` → `groupFilesByAgent` → rendered agent sections. Clicking a file
row dispatches `SELECT_AGENT` + `SET_ACTIVE_TAB`, which updates `state.selected`
and `state.activeTab` — the existing Agents view then renders that agent's detail
card, identical to how Grid's project clicks already navigate. No new state
field, no new reducer action, no new persistence-whitelist entry: this view reads
data that's already fully persisted via the existing `agents` array.

## Error handling / edge cases

- **Zero agents in the fleet**: `groupFilesByAgent` returns an empty array; the
  view renders its empty-state message instead of an empty card.
- **An agent whose only files are the two placeholder strings** (freshly spawned,
  not yet given real work): filtered out entirely by `groupFilesByAgent`, so it
  doesn't create an empty section header with no rows beneath it.
- **An agent later reactivated from idle** (`REACTIVATE_AGENT`) keeps whatever
  files it had when killed (no reset), so its section reappears with its prior
  file history — this matches `REACTIVATE_AGENT`'s existing behavior for every
  other agent field and needs no special handling here.

## Testing

**Unit** (`filesMath.test.ts`):
- Filters out both known placeholder strings, leaving only real files.
- An agent whose files are *entirely* placeholders is excluded from the result
  array (not included with an empty `files: []`).
- An agent with a mix of placeholder and real files keeps only the real ones,
  in their original order.
- Does not mutate the input `agents` array or any nested `Agent`/`AgentFile`
  object (a fresh array/objects are returned).
- Multiple agents with real files all appear, each with their own files intact.

**Manual GUI QA (plan-exit, per this project's convention):**
1. Files view renders every seeded agent that has real files, grouped correctly,
   with the right status glyph color and path text per file.
2. Spawning a new agent via Terminal (`spawn <name>`) — confirm it does **not**
   appear in Files (only placeholder files) until manually reasoned about (no
   action needed to also produce real files, since none of this app's mechanisms
   ever mutate an agent's files after spawn — just confirm the fresh agent is
   absent).
3. Clicking a file row navigates to the Agents view with that exact agent
   selected (matching `SELECT_AGENT`'s existing behavior verified elsewhere).
4. Reload the page — Files still renders identically (proves no new persistence
   gap exists, since nothing new was added to the whitelist).
5. Confirm no regressions in Agents' own FILES section, Grid's project-click
   navigation, or any other already-shipped view.
