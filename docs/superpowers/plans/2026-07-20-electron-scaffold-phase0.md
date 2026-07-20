# Electron Scaffold (Phase 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Electron as a fully additive layer on top of the existing aether-os Vite+React app, so `npm run electron:dev` opens an Electron window rendering the exact same app `npm run dev` already shows in a browser tab — no existing file moves, no real IPC yet, no packaging.

**Architecture:** A new `electron/` directory (main + preload, minimal), a new `electron.vite.config.ts` (structurally separate from the existing `vite.config.ts`), two new npm scripts, and a `.gitignore` entry. Zero files under `src/` are touched.

**Tech Stack:** Electron `^31.0.0` (matching TokenMonitor's pinned version), `electron-vite` `^5.0.0`.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-20-electron-scaffold-phase0-design.md` (commit `5128c8b`) — every requirement below is copied verbatim from it.
- Electron version: `^31.0.0`. `electron-vite` version: `^5.0.0`. Both as `devDependencies`.
- **Zero files under `src/` may be touched.** No existing file moves, no import-path changes.
- **`vite.config.ts` and the root `tsconfig.json` are not modified.** `electron.vite.config.ts` is a separate file; `electron-vite`'s own CLI refuses to load if misnamed to match Vite's convention, so the two cannot collide.
- **The existing `dev`, `build`, `test`, and `preview` npm scripts are not modified.** Only new scripts are added.
- `electron/tsconfig.json` is **not** added to the root `tsconfig.json`'s `references` array — it exists for editor/manual type-checking only, not to gate `npm run build`'s `tsc -b`.
- `electron/preload.ts` exposes nothing (an empty `contextBridge.exposeInMainWorld` call) — no real IPC in this phase.
- `electron/main.ts` has no IPC handlers, no custom menu, no tray icon — only window creation and URL/file loading.
- No packaging: no `electron-builder`, no installer config, no code signing.
- Baseline: 272 passing tests across 26 files, clean `tsc -b`, clean `npm run build`, working tree clean at commit `5128c8b` (the spec commit).

---

### Task 1: Electron scaffold (config, entry files, scripts)

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `electron.vite.config.ts`
- Create: `electron/main.ts`
- Create: `electron/preload.ts`
- Create: `electron/tsconfig.json`

**Interfaces:**
- Produces: `npm run electron:dev` and `npm run electron:build` scripts; a `window.aetherElectron` global (currently an empty object) that later phases will extend with real IPC methods.

- [ ] **Step 1: Install the new dependencies**

Run: `npm install --save-dev electron@^31.0.0 electron-vite@^5.0.0`

This updates `package.json`'s `devDependencies` and `package-lock.json` automatically. After this step, `package.json`'s `devDependencies` block should read (order may vary slightly by how npm writes it — that's fine, just confirm both entries are present):

```json
"devDependencies": {
  "@types/node": "^26.1.1",
  "@types/react": "^18.3.12",
  "@types/react-dom": "^18.3.1",
  "@vitejs/plugin-react": "^4.3.4",
  "electron": "^31.0.0",
  "electron-vite": "^5.0.0",
  "jsdom": "^25.0.1",
  "typescript": "^5.6.3",
  "vite": "^5.4.11",
  "vitest": "^2.1.8"
}
```

- [ ] **Step 2: Write `electron.vite.config.ts`**

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

- [ ] **Step 3: Write `electron/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true
  },
  "include": ["."]
}
```

Do **not** add this file to the root `tsconfig.json`'s `references` array (Global Constraint above).

- [ ] **Step 4: Write `electron/preload.ts`**

```ts
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('aetherElectron', {});
```

- [ ] **Step 5: Write `electron/main.ts`**

```ts
import { app, BrowserWindow } from 'electron';
import { join } from 'path';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
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
```

**Note:** the preload path (`'../preload/index.js'`) assumes `electron-vite`'s default build output layout (`out/main/index.js` next to `out/preload/index.js`). Step 8 below verifies this against the tool's *actual* output and corrects it if the real file extension or path differs (e.g. `.mjs` instead of `.js`) — do not treat a mismatch here as a plan error, just fix it to match reality.

- [ ] **Step 6: Wire npm scripts, the `main` field, and `.gitignore`**

In `package.json`, add to `scripts` (after `"test"`):

```json
"electron:dev": "electron-vite dev",
"electron:build": "electron-vite build"
```

Add a top-level `"main"` field (Electron reads this to locate its entry point once built; not required for `electron-vite dev` itself, but needed for build-output fidelity):

```json
"main": "out/main/index.js"
```

(Step 8 verifies this path against the real build output too.)

In `.gitignore`, add a new line: `out` (alongside the existing `dist` line — do not remove or modify any existing line).

- [ ] **Step 7: Verify the existing suite is completely undisturbed**

Run: `npm test && npx tsc -b && npm run build`
Expected: 272/272 tests passing, 26 files, 0 type errors, `dist/` build succeeds — byte-for-byte the same result as before this task. If anything here fails or differs, something in Steps 1-6 leaked into the existing renderer/build path — stop and fix before continuing (this is the task's single most important guarantee).

- [ ] **Step 8: Run the Electron build once, verify and correct output paths**

Run: `npm run electron:build`
Expected: succeeds, producing an `out/` directory. Inspect its actual structure (e.g. `ls -R out` or equivalent) and compare against what `electron/main.ts` (Step 5) and `package.json`'s `"main"` field (Step 6) assume. If the real output uses different filenames or extensions than `out/main/index.js` / `out/preload/index.js` (e.g. `.mjs`), update `electron/main.ts`'s preload path and `package.json`'s `"main"` field to match the real output exactly, then re-run `npm run electron:build` to confirm it still succeeds after the correction.

- [ ] **Step 9: Manual verification — `electron:dev` opens a real window**

Run: `npm run electron:dev`
Expected: an Electron window opens showing the real aether-os app (whatever view is active by default), not a blank or error screen. Edit a visible label in an existing component under `src/` while this is running and confirm the change appears in the window without restarting it (proves live-reload wiring is real). Stop the process afterward (it will keep running otherwise).

If you have no way to visually inspect an opened GUI window in your environment (no display/remote-debugging access), it is acceptable to instead verify: the process starts without throwing, produces no error output in its console/log within the first several seconds, and exits cleanly on interrupt. Note explicitly in your report whether you performed the full visual check or only this process-level check — do not claim a visual check you did not perform.

- [ ] **Step 10: Confirm the plain-browser path is unaffected**

Run: `npm run dev`, open the app in a normal browser tab, confirm it renders and behaves exactly as it did before this task (spot-check one view, e.g. Terminal). Stop the dev server afterward.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json .gitignore electron.vite.config.ts electron/main.ts electron/preload.ts electron/tsconfig.json
git commit -m "feat: add an additive Electron scaffold via electron-vite (Phase 0)"
```

---

### Task 2: Final integration QA

**Files:** None (verification only).

- [ ] **Step 1: Re-run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: 272/272 tests, 26 files, 0 type errors, build succeeds — unchanged from Task 1's Step 7.

- [ ] **Step 2: Manual GUI verification**

Using `npm run electron:dev`:
1. Confirm the Electron window opens showing the real app (repeat of Task 1 Step 9, performed by whoever has GUI/visual access — the user, if the controller's environment can't visually inspect the window).
2. Confirm `npm run dev` (plain browser) still works identically alongside it.
3. Confirm `npm run electron:build` still succeeds standalone (Task 1 Step 8, re-run once more after Task 1's commit to catch any last-minute discrepancy).

- [ ] **Step 3: Report results**

No commit for this task (verification only) unless a regression is found, in which case fix it, re-run Steps 1-2, and commit the fix separately.
