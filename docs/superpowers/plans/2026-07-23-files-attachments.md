# Files → Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Files tab into a real, standalone local file-attachment library — add a file via a native OS picker, see it listed (image thumbnail or generic badge), open it in its OS default app, delete it.

**Architecture:** A new electron-side `attachmentsStore.ts` owns `~/.aether-os/attachments/` (list/add/remove/thumbnail/open), exposed to the renderer via five new `ipcMain.handle`/`ipcRenderer.invoke` channels on `window.aetherElectron.attachments`. A new pure module, `src/components/files/attachmentsMath.ts`, replaces `filesMath.ts`'s `groupFilesByAgent` with `resolveCollisionName`/`formatFileSize`/`isImageExtension`. `FilesView.tsx` is rewritten to own its own local list state (no reducer/store involvement — nothing else in the app reads attachments) and the `Files` tab id is renamed to `Attachments` in `viewRegistry.ts`.

**Tech Stack:** Same as the existing project — React 18, Vite 5, TypeScript 5 (strict), Vitest, Electron (`electron-vite`). No new dependencies — `dialog`/`shell`/`fs` are all built into Electron/Node.

## Global Constraints

- Project root: `C:\Users\Matt\projects\aether-os` (already scaffolded; this plan extends it).
- Full design spec: `docs/superpowers/specs/2026-07-23-files-attachments-design.md` (commit `f98d0da`) — this plan implements it task-by-task; consult it for the "why" behind any decision below.
- **Scope for this plan:** `src/components/files/attachmentsMath.ts` (new, replaces `filesMath.ts`), `src/components/files/FilesView.tsx` (rewritten), `electron/attachmentsStore.ts` (new), `electron/main.ts` (modified — 5 new IPC handlers), `electron/preload.ts` (modified), `src/aetherElectron.d.ts` (modified), `src/viewRegistry.ts` / `viewRegistry.test.ts` (modified — `Files` → `Attachments` id rename). `src/components/files/filesMath.ts` / `filesMath.test.ts` are deleted once nothing imports them (Task 3).
- **`Agent.files`/`AgentFile` (the fictional roster's field, still read by Chat's `localResponder.ts`/`systemPrompt.ts`) are completely untouched by this plan.** Do not modify `src/state/types.ts`, `src/state/initialState.ts`, `src/components/chat/localResponder.ts`, or `src/components/chat/systemPrompt.ts`.
- **No Chat integration, no drag-and-drop, no filesystem-watching, no live screen capture, no file-type/size restriction beyond image-detection for thumbnails, no association with any agent/dispatch/project.** All explicit non-goals from the spec — do not add any of them.
- **No new `AetherState` field, no new reducer action, no `persistence.ts` change.** Attachments live entirely on disk and in `FilesView.tsx`'s own local component state.
- Storage location is `~/.aether-os/attachments/` (created lazily on first use, not at app startup).
- IPC channel names, exactly: `attachments:list`, `attachments:add`, `attachments:remove`, `attachments:thumbnail`, `attachments:open`.
- `thumbnail()` returns a `data:` URL (never a raw `file://` path — the renderer is sandboxed/context-isolated) or `null` for non-images / unreadable files.
- Match established visual/style conventions exactly: inline `CSSProperties` consts, `colors`/`fonts` tokens from `src/styles/tokens.ts`. The add-button idiom mirrors `UplinksView.tsx`'s pill styling; the row/avatar idiom mirrors the existing `FilesView.tsx`/`AgentRosterCard.tsx`.
- `attachmentsMath.ts` gets full Vitest coverage (pure logic). `attachmentsStore.ts`/`main.ts`/`preload.ts` (fs/dialog/shell-touching electron code) get **no** automated coverage, matching this project's established precedent for `electron/*.ts`. `FilesView.tsx` is verified via typecheck + manual GUI QA (Task 4), matching every prior presentational-only component.
- Run `npm test`, `npx tsc -b`, and `npm run build` clean before every commit. Baseline going into this plan: **290 passing tests across 28 files** (confirmed via `npm test` immediately before this plan was written).

---

## File Structure

```
aether-os/
  electron/
    attachmentsStore.ts             NEW — list/add/remove/thumbnail/open against ~/.aether-os/attachments/
    main.ts                          MODIFIED — 5 new ipcMain.handle registrations
    preload.ts                       MODIFIED — window.aetherElectron.attachments surface
  src/
    aetherElectron.d.ts               MODIFIED — attachments type declarations
    components/
      files/
        attachmentsMath.ts           NEW — resolveCollisionName, formatFileSize, isImageExtension, AttachmentInfo type
        attachmentsMath.test.ts      NEW
        filesMath.ts                  DELETED (Task 3) — groupFilesByAgent has no other caller
        filesMath.test.ts             DELETED (Task 3)
        FilesView.tsx                  REWRITTEN — attachment library UI
    viewRegistry.ts                    MODIFIED — 'Files' id → 'Attachments'
    viewRegistry.test.ts               MODIFIED — same rename
```

---

### Task 1: Pure logic — `attachmentsMath.ts`

Foundational module both the electron backend (Task 2) and the view (Task 3) depend on. Built and tested first, in isolation, per TDD.

**Files:**
- Create: `src/components/files/attachmentsMath.ts`
- Create: `src/components/files/attachmentsMath.test.ts`

**Interfaces:**
- Produces: `AttachmentInfo` (`{ name: string; size: number; mtimeMs: number }`), `resolveCollisionName(existingNames: string[], desiredName: string): string`, `formatFileSize(bytes: number): string`, `isImageExtension(name: string): boolean` — all consumed by Task 2 (`attachmentsStore.ts`) and Task 3 (`FilesView.tsx`).

- [ ] **Step 1: Write the failing tests**

Create `src/components/files/attachmentsMath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveCollisionName, formatFileSize, isImageExtension } from './attachmentsMath';

describe('resolveCollisionName', () => {
  it('returns the desired name unchanged when it does not collide', () => {
    expect(resolveCollisionName(['other.png'], 'screenshot.png')).toBe('screenshot.png');
  });

  it('appends " (2)" before the extension on a first collision', () => {
    expect(resolveCollisionName(['screenshot.png'], 'screenshot.png')).toBe('screenshot (2).png');
  });

  it('appends " (3)" when " (2)" is already taken', () => {
    expect(resolveCollisionName(['screenshot.png', 'screenshot (2).png'], 'screenshot.png')).toBe('screenshot (3).png');
  });

  it('handles a name with no extension', () => {
    expect(resolveCollisionName(['README'], 'README')).toBe('README (2)');
  });
});

describe('formatFileSize', () => {
  it('formats 0 bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });

  it('formats a byte count just under 1 KB', () => {
    expect(formatFileSize(999)).toBe('999 B');
  });

  it('formats exactly 1 KB', () => {
    expect(formatFileSize(1000)).toBe('1.0 KB');
  });

  it('formats exactly 1 MB', () => {
    expect(formatFileSize(1_000_000)).toBe('1.0 MB');
  });
});

describe('isImageExtension', () => {
  it.each(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])('is true for .%s (case-insensitive)', (ext) => {
    expect(isImageExtension(`photo.${ext}`)).toBe(true);
    expect(isImageExtension(`photo.${ext.toUpperCase()}`)).toBe(true);
  });

  it('is false for a non-image extension', () => {
    expect(isImageExtension('notes.txt')).toBe(false);
  });

  it('is false for a name with no extension', () => {
    expect(isImageExtension('README')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- attachmentsMath`
Expected: FAIL — `src/components/files/attachmentsMath.ts` does not exist yet.

- [ ] **Step 3: Implement `attachmentsMath.ts`**

Create `src/components/files/attachmentsMath.ts`:

```ts
export interface AttachmentInfo {
  name: string;
  size: number;
  mtimeMs: number;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

function splitExt(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf('.');
  if (i <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i) };
}

export function resolveCollisionName(existingNames: string[], desiredName: string): string {
  if (!existingNames.includes(desiredName)) return desiredName;
  const { base, ext } = splitExt(desiredName);
  let n = 2;
  let candidate = `${base} (${n})${ext}`;
  while (existingNames.includes(candidate)) {
    n += 1;
    candidate = `${base} (${n})${ext}`;
  }
  return candidate;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function isImageExtension(name: string): boolean {
  const { ext } = splitExt(name);
  return IMAGE_EXTENSIONS.has(ext.slice(1).toLowerCase());
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- attachmentsMath`
Expected: PASS (16 tests: 4 `resolveCollisionName` + 4 `formatFileSize` + 6 `isImageExtension` `it.each` iterations, one test per extension, each asserting both the lowercase and uppercase form + 2 more explicit `isImageExtension` tests = 4 + 4 + 6 + 2 = 16).

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (306 total: 290 + 16 new), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/files/attachmentsMath.ts src/components/files/attachmentsMath.test.ts
git commit -m "feat: add attachmentsMath pure logic for the Files-to-Attachments migration"
```

---

### Task 2: Electron backend — `attachmentsStore.ts`, IPC wiring, preload

Adds the disk-backed store and the IPC surface the view will call. No UI changes yet — additive only, `FilesView.tsx`/`filesMath.ts` are untouched in this task.

**Files:**
- Create: `electron/attachmentsStore.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/aetherElectron.d.ts`

**Interfaces:**
- Consumes: `AttachmentInfo`, `resolveCollisionName`, `isImageExtension` from Task 1's `src/components/files/attachmentsMath.ts`.
- Produces: `window.aetherElectron.attachments` = `{ list(): Promise<AttachmentInfo[]>; add(): Promise<string[]>; remove(name: string): Promise<void>; thumbnail(name: string): Promise<string | null>; open(name: string): Promise<void> }` — consumed by Task 3's `FilesView.tsx`.

- [ ] **Step 1: Implement `electron/attachmentsStore.ts`**

```ts
import { dialog, shell } from 'electron';
import { promises as fs } from 'fs';
import { join, basename, extname } from 'path';
import { resolveCollisionName, isImageExtension, type AttachmentInfo } from '../src/components/files/attachmentsMath';

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export function createAttachmentsStore(dir: string) {
  return {
    async list(): Promise<AttachmentInfo[]> {
      await ensureDir(dir);
      const names = await fs.readdir(dir);
      const infos = await Promise.all(
        names.map(async (name) => {
          const stat = await fs.stat(join(dir, name));
          return { name, size: stat.size, mtimeMs: stat.mtimeMs };
        }),
      );
      return infos.sort((a, b) => b.mtimeMs - a.mtimeMs);
    },

    async add(): Promise<string[]> {
      await ensureDir(dir);
      const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
      if (result.canceled) return [];
      const namesSoFar = await fs.readdir(dir);
      const written: string[] = [];
      for (const srcPath of result.filePaths) {
        const finalName = resolveCollisionName(namesSoFar, basename(srcPath));
        namesSoFar.push(finalName);
        await fs.copyFile(srcPath, join(dir, finalName));
        written.push(finalName);
      }
      return written;
    },

    async remove(name: string): Promise<void> {
      await fs.unlink(join(dir, name));
    },

    async thumbnail(name: string): Promise<string | null> {
      if (!isImageExtension(name)) return null;
      try {
        const buf = await fs.readFile(join(dir, name));
        const ext = extname(name).slice(1).toLowerCase();
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        return `data:image/${mime};base64,${buf.toString('base64')}`;
      } catch {
        return null;
      }
    },

    async open(name: string): Promise<void> {
      await shell.openPath(join(dir, name));
    },
  };
}
```

- [ ] **Step 2: Wire IPC handlers into `electron/main.ts`**

Add the import (alongside the existing `createLiveAgentTracker` import):

```ts
import { createAttachmentsStore } from './attachmentsStore';
```

Add, right after the existing `const liveAgentTracker = createLiveAgentTracker(...)` line:

```ts
const attachmentsStore = createAttachmentsStore(join(os.homedir(), '.aether-os', 'attachments'));
```

Add, at the end of the file, after the existing `ipcMain.on('pty:resize', ...)` block:

```ts
ipcMain.handle('attachments:list', () => attachmentsStore.list());
ipcMain.handle('attachments:add', () => attachmentsStore.add());
ipcMain.handle('attachments:remove', (_event, name: string) => attachmentsStore.remove(name));
ipcMain.handle('attachments:thumbnail', (_event, name: string) => attachmentsStore.thumbnail(name));
ipcMain.handle('attachments:open', (_event, name: string) => attachmentsStore.open(name));
```

- [ ] **Step 3: Expose the API in `electron/preload.ts`**

Add the type import (alongside the existing `RealAgentDispatch` import):

```ts
import type { AttachmentInfo } from '../src/components/files/attachmentsMath';
```

Add, inside the `contextBridge.exposeInMainWorld('aetherElectron', { ... })` object, after the existing `agents: { ... }` block:

```ts
  attachments: {
    list: (): Promise<AttachmentInfo[]> => ipcRenderer.invoke('attachments:list'),
    add: (): Promise<string[]> => ipcRenderer.invoke('attachments:add'),
    remove: (name: string): Promise<void> => ipcRenderer.invoke('attachments:remove', name),
    thumbnail: (name: string): Promise<string | null> => ipcRenderer.invoke('attachments:thumbnail', name),
    open: (name: string): Promise<void> => ipcRenderer.invoke('attachments:open', name),
  },
```

- [ ] **Step 4: Update the type declaration in `src/aetherElectron.d.ts`**

Add the type import (alongside the existing two):

```ts
import type { AttachmentInfo } from './components/files/attachmentsMath';
```

Add, inside the `aetherElectron?: { ... }` interface, after the existing `agents: { ... }` block:

```ts
      attachments: {
        list: () => Promise<AttachmentInfo[]>;
        add: () => Promise<string[]>;
        remove: (name: string) => Promise<void>;
        thumbnail: (name: string) => Promise<string | null>;
        open: (name: string) => Promise<void>;
      };
```

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (306/306, unchanged from Task 1 — this task adds no new unit tests, per this project's precedent for `electron/*.ts`), 0 type errors (confirms `attachmentsStore.ts`/`main.ts`/`preload.ts`/`aetherElectron.d.ts` all typecheck cleanly together).

- [ ] **Step 6: Commit**

```bash
git add electron/attachmentsStore.ts electron/main.ts electron/preload.ts src/aetherElectron.d.ts
git commit -m "feat: add attachments electron backend (list/add/remove/thumbnail/open over IPC)"
```

---

### Task 3: Rewrite `FilesView.tsx`, rename the tab, remove dead code

Rewires the view onto the new attachments API, renames the `Files` tab id to `Attachments`, and — now that nothing imports it — deletes `filesMath.ts`/`filesMath.test.ts`.

**Files:**
- Modify (rewrite): `src/components/files/FilesView.tsx`
- Modify: `src/viewRegistry.ts`
- Modify: `src/viewRegistry.test.ts`
- Delete: `src/components/files/filesMath.ts`
- Delete: `src/components/files/filesMath.test.ts`

**Interfaces:**
- Consumes: `window.aetherElectron.attachments` (Task 2), `AttachmentInfo`/`formatFileSize`/`isImageExtension` (Task 1).
- Produces: `FilesView()` — unchanged export name/signature, registered under the renamed `Attachments` id.

- [ ] **Step 1: Verify `groupFilesByAgent` has no other caller before deleting anything**

Run: `grep -rn "groupFilesByAgent\|filesMath" src --include="*.ts" --include="*.tsx"`
Expected output: only `src/components/files/filesMath.ts` (definition) and `src/components/files/filesMath.test.ts` (its test) — and, before this step's edits, `src/components/files/FilesView.tsx`'s import (removed by Step 2 below). If any other file appears, STOP and report BLOCKED — this plan's Global Constraints assume `groupFilesByAgent` is safe to remove once `FilesView.tsx` stops calling it.

- [ ] **Step 2: Rewrite `src/components/files/FilesView.tsx`**

Replace the entire file:

```tsx
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { formatFileSize, isImageExtension, type AttachmentInfo } from './attachmentsMath';

export function FilesView() {
  const [files, setFiles] = useState<AttachmentInfo[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const list = await window.aetherElectron?.attachments.list();
    setFiles(list ?? []);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    files.forEach((f) => {
      if (isImageExtension(f.name) && !(f.name in thumbnails)) {
        window.aetherElectron?.attachments.thumbnail(f.name).then((dataUrl) => {
          if (dataUrl) setThumbnails((prev) => ({ ...prev, [f.name]: dataUrl }));
        });
      }
    });
  }, [files, thumbnails]);

  const addFile = async () => {
    await window.aetherElectron?.attachments.add();
    refresh();
  };

  const removeFile = async (name: string) => {
    try {
      await window.aetherElectron?.attachments.remove(name);
    } catch {
      // already gone on disk (e.g. removed externally) — fall through to refresh so the UI self-corrects
    } finally {
      refresh();
    }
  };

  const openFile = (name: string) => {
    window.aetherElectron?.attachments.open(name);
  };

  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>ATTACHMENTS</div>
        <span onClick={addFile} style={addButtonStyle}>+ ADD FILE</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {files.map((f) => (
          <div key={f.name} style={rowStyle}>
            <span onClick={() => openFile(f.name)} style={thumbStyle}>
              {thumbnails[f.name] ? <img src={thumbnails[f.name]} alt="" style={imgStyle} /> : extBadge(f.name)}
            </span>
            <div onClick={() => openFile(f.name)} style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
              <div style={nameStyle}>{f.name}</div>
              <div style={sizeStyle}>{formatFileSize(f.size)}</div>
            </div>
            <span onClick={() => removeFile(f.name)} style={deleteStyle}>×</span>
          </div>
        ))}
        {!files.length && <div style={emptyStyle}>no files attached yet — click + ADD FILE to attach a screenshot or document</div>}
      </div>
    </div>
  );
}

function extBadge(name: string): string {
  const i = name.lastIndexOf('.');
  return (i > 0 ? name.slice(i + 1) : '?').slice(0, 4).toUpperCase();
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
const addButtonStyle: CSSProperties = {
  cursor: 'pointer',
  font: `600 10px/1 ${fonts.ui}`,
  letterSpacing: 1,
  padding: '7px 14px',
  borderRadius: 7,
  color: '#04202b',
  background: 'linear-gradient(180deg,#7ef0ff,#17b8d8)',
  boxShadow: '0 0 10px rgba(95,220,255,.4)',
};
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 9px',
  borderRadius: 9,
  border: '1px solid rgba(80,190,220,.16)',
  background: 'rgba(6,20,28,.5)',
};
const thumbStyle: CSSProperties = {
  width: 32,
  height: 32,
  flex: 'none',
  borderRadius: 6,
  overflow: 'hidden',
  cursor: 'pointer',
  background: 'repeating-linear-gradient(45deg,#0e3340 0 5px,#123f4e 5px 10px)',
  border: `1px solid ${colors.accentCyanSoft}`,
  display: 'grid',
  placeItems: 'center',
  font: `700 9px/1 ${fonts.mono}`,
  color: colors.accentCyanSoft,
};
const imgStyle: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover' };
const nameStyle: CSSProperties = {
  font: `600 12px/1.3 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const sizeStyle: CSSProperties = { font: `400 10px/1.3 ${fonts.mono}`, color: colors.textDim, marginTop: 2 };
const deleteStyle: CSSProperties = {
  flex: 'none',
  cursor: 'pointer',
  font: `700 14px/1 ${fonts.ui}`,
  color: colors.dangerSoft,
  padding: '2px 6px',
};
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
```

- [ ] **Step 3: Rename the tab id in `src/viewRegistry.ts`**

Change:

```ts
  { id: 'Files', inTopBar: true, inSidebar: false, component: FilesView },
```

to:

```ts
  { id: 'Attachments', inTopBar: true, inSidebar: false, component: FilesView },
```

Do not change `inTopBar`/`inSidebar`, the import statement, or the component name — only the `id` string.

- [ ] **Step 4: Update `src/viewRegistry.test.ts`**

Change:

```ts
    expect(topBarIds).toEqual(['Terminal', 'Chat', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Files']);
```

to:

```ts
    expect(topBarIds).toEqual(['Terminal', 'Chat', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Attachments']);
```

Change:

```ts
  it('getViewComponent resolves Files now that it is built', () => {
    expect(getViewComponent('Files')).not.toBeNull();
  });
```

to:

```ts
  it('getViewComponent resolves Attachments now that it is built', () => {
    expect(getViewComponent('Attachments')).not.toBeNull();
  });
```

- [ ] **Step 5: Delete the dead files**

```bash
git rm src/components/files/filesMath.ts src/components/files/filesMath.test.ts
```

- [ ] **Step 6: Run the full suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (301 total: 306 − 5 removed `filesMath.test.ts` tests), 0 type errors, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/components/files/FilesView.tsx src/viewRegistry.ts src/viewRegistry.test.ts
git commit -m "feat: rebuild Files as a real attachment library, rename tab to Attachments"
```

`git status` should show no remaining changes after this commit — Step 5's `git rm` already staged the two deletions, and this step's `git add` stages the three modified files; one commit covers all five.

---

### Task 4: Final integration QA

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (301/301), 0 type errors, build succeeds.

- [ ] **Step 2: Manual QA checklist (Electron, not the plain browser dev server — this feature needs `window.aetherElectron`)**

Run: `npm run electron:dev`.

- [ ] Attachments tab (top bar, where Files used to be) renders the empty state on first launch (or shows any files already present from prior manual testing).
- [ ] "+ ADD FILE" opens the native OS file picker.
- [ ] Selecting an image file adds it, shows its thumbnail within the row, and displays the correct formatted size.
- [ ] Selecting a non-image file (e.g. a `.txt` or `.md`) adds it with the generic extension badge instead of a thumbnail.
- [ ] Adding a file with the same name as an existing attachment produces a ` (2)`-suffixed copy — confirm both are listed and both are independently openable, and that the original file was not overwritten (its content is unchanged).
- [ ] Clicking a row (thumbnail, name, or size) opens the file in its OS default application.
- [ ] Clicking a row's × removes it from the list; confirm via a file explorer that it's also gone from `~/.aether-os/attachments/` on disk.
- [ ] Reload the app (or restart `electron:dev`) — remaining attachments persist (real files on disk, not reducer state).
- [ ] Confirm no regressions elsewhere: Terminal, Dashboard, Chat, Agents, Grid, Projects, Memory, Analytics, Uplinks, Settings all still route and highlight correctly.
- [ ] Confirm Chat is unaffected — open a per-agent chat channel and verify its replies still reference the fictional agent's own `Agent.files` data as before (e.g. via `localResponder.ts`'s offline fallback) — this plan does not touch that code path, but it's worth a live check since both features share the word "files."

- [ ] **Step 3: Address any regression found in Step 2**

If Step 2 surfaces a real regression (not a pre-existing, already-documented quirk), fix it and commit separately with a `fix:` message before considering this plan done. If nothing was found, skip this step.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-23-files-attachments.md`. Executed via the same per-task pipeline as prior plans in this repo: a fresh implementer subagent per task, a fresh reviewer subagent (spec compliance + code quality) before commit, then one whole-branch review after all tasks land.

### Critical Files for Implementation
- C:\Users\Matt\projects\aether-os\src\components\files\attachmentsMath.ts
- C:\Users\Matt\projects\aether-os\electron\attachmentsStore.ts
- C:\Users\Matt\projects\aether-os\electron\main.ts
- C:\Users\Matt\projects\aether-os\electron\preload.ts
- C:\Users\Matt\projects\aether-os\src\aetherElectron.d.ts
- C:\Users\Matt\projects\aether-os\src\components\files\FilesView.tsx
- C:\Users\Matt\projects\aether-os\src\viewRegistry.ts
