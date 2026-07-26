# Desktop Polish (Phase 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Aether OS feel like a native desktop tool instead of a web page in a stock window: bundled fonts (no CDN flash, works offline), a frame that scales to fit the actual window, native window behavior (min size, remembered bounds, single instance, no menu bar), and frameless chrome with the existing Aether top bar acting as the title bar.

**Architecture:** Four independent concerns, ordered so visual changes land on a stable base. Fonts move from the Google CDN to versioned `@fontsource` npm packages imported in `main.tsx`. The fixed 1536×1024 design frame is preserved exactly (faithful-port constraint stands) but wrapped in a scale-to-fit container driven by a pure `computeFrameScale` function + a `useViewportScale` hook — letterboxed, never stretched. Window behavior lives entirely in `electron/main.ts` + a small pure `clampBoundsToDisplays` helper so bounds restoration can't strand the window off-screen. Frameless chrome uses `frame: false` with `-webkit-app-region: drag` on the top bar and three IPC-backed window buttons (minimize / maximize / close) added to the top bar's right cluster.

**Tech Stack:** TypeScript, React, Vitest, Electron (`electron-vite`). New deps: `@fontsource/rajdhani`, `@fontsource/space-mono` (renderer, exact-version pinned).

## Global Constraints

- The 1536×1024 design frame in `AppShell.tsx` keeps its exact dimensions — scaling wraps it, nothing inside reflows. Do not make inner views responsive in this plan.
- `npm test` and `npm run build` (and `npm run electron:build` for tasks touching `electron/`) must be clean before every commit.
- Do not modify `ptyManager.ts`, `historyScanner.ts`, `liveAgentTracker.ts`, or any usage-scan/IPC surface beyond the new `window:*` channels in Task 4. If `electron/main.ts` has uncommitted in-flight changes from another plan when this one starts, coordinate: finish/commit that work first, then start Task 3.
- Window-bounds persistence writes a small JSON file under `app.getPath('userData')` — never into the repo tree.
- App icon: wiring goes in (`icon:` option + `build/icon.png` path), but generating the actual icon asset is **user-supplied and may be genuinely blocked** — if no `build/icon.png` exists, skip the option gracefully (existsSync guard), note it in PROGRESS.md as blocked-not-skipped, and do not invent a placeholder image.
- Frameless chrome must keep: window resizing from edges, double-click-top-bar to maximize/restore, and all existing top-bar interactive elements clickable (`-webkit-app-region: no-drag` on them).

---

### Task 1: Bundle Rajdhani + Space Mono locally

**Files:**
- Modify: `package.json` (add `@fontsource/rajdhani`, `@fontsource/space-mono`)
- Modify: `src/main.tsx` (import weights 400/500/600/700 for Rajdhani, 400/700 for Space Mono)
- Modify: `index.html` (remove the three Google Fonts `<link>` tags)

**Steps:**
- [ ] `npm install @fontsource/rajdhani @fontsource/space-mono`
- [ ] Import exactly the weights the app uses today (Rajdhani 400/500/600/700, Space Mono 400/700 — matching the current CDN URL) at the top of `src/main.tsx`.
- [ ] Remove the `preconnect` and stylesheet `<link>` tags from `index.html`.
- [ ] Verify: `npm run build` clean; run `npm run electron:dev` with network disabled (or DevTools offline) — typography renders identically, no fallback-font flash on launch.

### Task 2: Scale-to-fit frame

**Files:**
- Create: `src/components/layout/frameScale.ts` + `frameScale.test.ts`
- Create: `src/components/layout/useViewportScale.ts`
- Modify: `src/components/layout/AppShell.tsx`

**Interfaces:**
- Produces: `computeFrameScale(viewportW: number, viewportH: number, frameW?: number, frameH?: number): number` — pure; returns `min(viewportW/frameW, viewportH/frameH)` clamped to `(0, 1]` by default, with an `allowUpscale` opt-in that removes the upper clamp. Guard degenerate inputs (`<= 0` → returns 1).
- Produces: `useViewportScale()` — listens to `window.resize` (and fires once on mount), returns the current scale for the 1536×1024 frame.

**Steps:**
- [ ] `frameScale.test.ts`: exact-fit → 1; wider-than-tall viewport limited by height; taller limited by width; degenerate inputs; upscale clamped off by default and allowed with the flag.
- [ ] Wrap `frameStyle`'s div in a full-viewport flex-centered container (`background` matching the app's outer void color) and apply `transform: scale(n)` with `transformOrigin: 'center center'` to the frame.
- [ ] Manual verify at three window sizes (smaller than frame, exact, larger): letterboxing centered, no scrollbars, reactor canvases and xterm remain crisp enough at scale ≠ 1 (known acceptable: xterm renders at design size and is visually scaled; note this in the plan's PROGRESS entry as a documented tradeoff, not a bug).

### Task 3: Native window behavior

**Files:**
- Create: `electron/windowBounds.ts` + `electron/windowBounds.test.ts`
- Modify: `electron/main.ts`

**Interfaces:**
- Produces: `clampBoundsToDisplays(saved: Bounds, displays: Rect[]): Bounds | null` — pure; returns `null` (caller uses defaults) unless at least ~100×100px of the saved bounds intersects some display; clamps size to the largest display.
- Produces: `loadWindowBounds(file: string)` / `saveWindowBounds(file: string, bounds: Bounds)` — JSON read/write, both swallow errors (corrupt/missing file → null; failed write → warn only).

**Steps:**
- [ ] `windowBounds.test.ts`: on-screen bounds pass through; fully off-screen → null; partially off-screen at the intersection threshold; oversized bounds clamped; corrupt JSON file → null.
- [ ] `main.ts`: single-instance lock first (`app.requestSingleInstanceLock()`; second instance → focus + restore existing window and quit the new one).
- [ ] `BrowserWindow` options: `minWidth: 1024, minHeight: 700`, `autoHideMenuBar: true` plus `Menu.setApplicationMenu(null)`, restored bounds from `clampBoundsToDisplays(loadWindowBounds(...), screen.getAllDisplays()...)` falling back to today's 1400×900, and `icon` only if `build/icon.png` exists (see Global Constraints).
- [ ] Persist bounds on `resize`/`move` (debounced ~500ms) and on `close`; skip saving while maximized, save `isMaximized` separately and restore it.
- [ ] Manual verify: relaunch restores size/position/maximized; second launch focuses the first; menu bar gone; dragging to a disconnected-monitor position then relaunching lands on-screen.

### Task 4: Frameless chrome + top-bar window controls

**Files:**
- Modify: `electron/main.ts` (`frame: false`; `window:minimize` / `window:toggleMaximize` / `window:close` IPC handlers; `window:isMaximized` push on maximize/unmaximize)
- Modify: `electron/preload.ts` (expose the three actions + maximize-state subscription under the existing bridge namespace)
- Modify: the top-bar component in `src/components/layout/` (drag region + a right-aligned MIN / MAX / CLOSE control cluster styled with existing tokens — Space Mono glyphs, no OS-native imagery)
- Create: co-located test for any extracted pure helper (e.g. maximize-glyph state mapping) — do not force a test where none is meaningful

**Steps:**
- [ ] `frame: false` on the BrowserWindow; confirm edge-resize still works on Windows.
- [ ] Top bar: `-webkit-app-region: drag` on the bar, `no-drag` on every interactive child (existing controls + the new cluster); double-click on a drag region toggles maximize (Electron default — verify, don't reimplement).
- [ ] Window control cluster: minimize, maximize/restore (glyph reflects `window:isMaximized`), close — wired through the preload bridge; hover styles from existing tokens; hit targets ≥ 28×28px.
- [ ] In browser-only `npm run dev` (no Electron bridge), the cluster hides itself cleanly — feature-detect the bridge, no errors.
- [ ] Manual verify: drag, double-click maximize, all three buttons, DevTools still reachable (`Ctrl+Shift+I` via `webContents` — confirm it survives menu removal in dev).

---

After all four tasks: whole-branch review, then a PROGRESS.md entry in the established format (including the xterm-scaling tradeoff note from Task 2 and, if applicable, the blocked icon asset).
