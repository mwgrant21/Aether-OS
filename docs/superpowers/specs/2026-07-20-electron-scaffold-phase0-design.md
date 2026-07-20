# Electron Scaffold (Phase 0) — Design

## Context

aether-os is a pure Vite + React 18 + TypeScript (strict) browser SPA today —
confirmed via `package.json` (no `electron`, no `node-pty`, no server
dependency). Its renderer lives in a flat `src/` directory (`components/`,
`state/`, `styles/`, `utils/`, `App.tsx`, `main.tsx`, `viewRegistry.ts`), built
by a single root-level `vite.config.ts` (`react()` + `chatProxyPlugin()`
plugins, Vitest config for `jsdom` tests) and a single root-level
`tsconfig.json` (`include: ["src"]`, references `tsconfig.node.json` for
`vite.config.ts`/`vite-plugins/**`). `npm run dev` runs plain `vite`; `npm run
build` runs `tsc -b && vite build`; `npm test` runs `vitest run`.

This is the first phase of a larger, user-approved migration: turning aether-os
from a themed browser simulation into the user's real personal Claude Code
dashboard (the "evolution of TokenMonitor," which already does this via
Electron + `node-pty`). Phase 0's only job is unlocking Node/native-module
access via Electron — no real terminal, no real session data, no user-visible
behavior change yet. Later phases (real `node-pty` terminal, real
`~/.claude/projects/**/*.jsonl` ingestion, live session monitoring) build on
top of what Phase 0 establishes and are explicitly out of scope here.

`electron-vite` (verified against its actual v5.0.0 source, not just docs
prose) fully supports the additive approach this spec takes: `renderer.root`
accepts any directory (only defaults to `./src/renderer`), `main`/`preload`
entry paths are freely overridable via `build.lib.entry`, and its own config
file (`electron.vite.config.ts`) is structurally incapable of colliding with
`vite.config.ts` — the tool refuses to load if its config file is misnamed to
match Vite's own convention.

## Goal

Add Electron as a fully additive layer on top of the existing app: a new
`electron/` directory (main + preload), a new `electron.vite.config.ts`, and
two new npm scripts (`electron:dev`, `electron:build`) — such that
`npm run electron:dev` opens an Electron window rendering the exact same React
app that `npm run dev` already shows in a browser tab, with live-reload intact.

## Non-goals

- **No restructuring of existing `src/`.** Every existing file, its location,
  and its import paths stay exactly as they are. This is Phase 0's central
  constraint, chosen over mirroring TokenMonitor's `src/main`/`src/preload`/
  `src/renderer` split, which would touch every import path in the app for a
  benefit that's mostly aesthetic at this stage.
- **No changes to the existing `dev`, `build`, or `test` npm scripts**, nor to
  `vite.config.ts` or the root `tsconfig.json`. `npm test`/`npx tsc -b`/`npm
  run build` must behave identically before and after this phase — this is
  the primary thing Task 1's tests verify.
- **No real IPC, no `node-pty`, no real terminal wiring.** `electron/preload.ts`
  exposes nothing yet; `electron/main.ts` has no IPC handlers. These are
  Phase 1's job, once this scaffold exists for them to build on.
- **No packaging, no installer, no code signing.** `electron-vite build`
  verifies the production build path works, but nothing wires `electron-builder`,
  NSIS, or an AppContainer ACL grant — all deferred until (if ever) the user
  wants a packaged, installable build, which isn't needed for personal daily
  use via `npm run electron:dev`.
- **No new UI, view, or state.** This phase touches zero files under `src/`.

## Architecture

### New dependencies

`electron` (pinned `^31.0.0`, matching TokenMonitor's own pinned version
exactly — so Phase 1's `node-pty` integration reuses an Electron/Node ABI
combo already proven to work with prebuilt binaries, rather than risking a
fresh mismatch) and `electron-vite` (`^5.0.0`), both as `devDependencies`.

### `electron.vite.config.ts` (new, project root)

A config file structurally separate from `vite.config.ts` — `electron-vite`'s
own CLI only reads files named `electron.vite.config.*` and throws if that
file is named to match Vite's own convention, so the two configs cannot
conflict or be confused with each other by tooling.

```ts
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  main: {
    build: {
      lib: { entry: resolve(__dirname, 'electron/main.ts') },
    },
  },
  preload: {
    build: {
      lib: { entry: resolve(__dirname, 'electron/preload.ts') },
    },
  },
  renderer: {
    root: '.',
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
      },
    },
    plugins: [react()],
  },
});
```

`renderer.root: '.'` mirrors the existing `vite.config.ts`'s implicit root
(the project root, with `index.html` referencing `/src/main.tsx`) — no
renderer files move. `main`/`preload` entries point at two new files below,
not the tool's conventional `src/main`/`src/preload` paths.

### `electron/main.ts` (new)

The Electron entry point. Deliberately minimal: opens one `BrowserWindow`,
loads the electron-vite dev server URL in development (electron-vite injects
`process.env['ELECTRON_RENDERER_URL']` automatically under `electron-vite
dev`) or the built renderer's `index.html` in production. No IPC handlers, no
custom menu, no tray icon — anything beyond "the app renders" is explicitly
out of scope for this phase.

### `electron/preload.ts` (new)

A minimal `contextBridge` stub — establishes the pattern Phase 1's real pty
IPC will extend, without exposing anything yet:

```ts
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('aetherElectron', {});
```

### `electron/tsconfig.json` (new)

A separate TypeScript project for the Electron main/preload context (Node
module resolution, no DOM lib) — explicitly **not** added to the root
`tsconfig.json`'s `references` array, so `npx tsc -b` (which currently only
builds the renderer's `src` project plus `tsconfig.node.json`) continues to
type-check exactly what it does today, unchanged. `electron-vite build`
transpiles/bundles `electron/main.ts` and `electron/preload.ts` itself (via
esbuild internally) regardless of this file — it exists for editor
type-checking, not to gate the build.

### npm scripts (additive only)

```json
"electron:dev": "electron-vite dev",
"electron:build": "electron-vite build"
```

Added alongside the existing `dev`/`build`/`test`/`preview` scripts, which are
not modified.

### `.gitignore`

One new line: `out` (electron-vite's build output directory), alongside the
existing `dist` entry (plain Vite's own build output).

## Data flow

`npm run electron:dev` → `electron-vite dev` starts a Vite dev server for the
renderer (reading `electron.vite.config.ts`'s `renderer` block, which points
at the same `index.html`/`src/` the existing `vite.config.ts` already serves)
→ launches Electron with `electron/main.ts` as its entry → `main.ts` opens a
`BrowserWindow` and loads `process.env['ELECTRON_RENDERER_URL']` → the exact
same React app renders, now inside an Electron window instead of a browser
tab. Editing any file under `src/` triggers the same HMR path Vite already
uses for `npm run dev`, since it's the same renderer source tree.

## Error handling / edge cases

- **Electron window fails to load the dev server** (e.g. port conflict): this
  phase has no fallback logic — `electron-vite dev`'s own error output surfaces
  the problem directly, no custom handling is added, since this is a
  developer-facing dev tool, not a production error path yet.
- **`electron/tsconfig.json` accidentally included in the root build**: guarded
  against structurally — the root `tsconfig.json`'s `references` array is not
  modified by this plan, so there's no path by which `tsc -b` picks up the new
  Electron-context files.

## Testing

**No new unit tests.** This phase adds zero application logic — it is
scaffolding/configuration, not feature code, so Vitest isn't the right tool
here (matching this project's own convention of only writing tests for real
derivations/state changes, not for build-tool wiring).

**Automated verification (must pass unchanged):**
- `npm test` — same pass count as before this phase (272/272 at time of
  writing), proving zero disturbance to the existing renderer/test suite.
- `npx tsc -b` — clean, proving the renderer's own typecheck path (unchanged
  `tsconfig.json`/`references`) is undisturbed.
- `npm run build` — succeeds, producing the same `dist/` output shape as
  before.

**Manual verification (plan-exit):**
1. `npm run electron:dev` opens an Electron window showing the real app
   (whatever view is active by default), not a blank/error screen.
2. Editing a file under `src/` (e.g. a label in an existing component) live-reloads
   inside the Electron window, proving the dev-server wiring is real, not a
   one-shot static load.
3. `npm run electron:build` completes without error (build-path fidelity only
   — the built output is not manually launched as a packaged app, since
   packaging is out of scope for this phase).
4. `npm run dev` (plain Vite, browser tab) still works exactly as before —
   confirms the additive changes didn't disturb the existing pure-browser path.
