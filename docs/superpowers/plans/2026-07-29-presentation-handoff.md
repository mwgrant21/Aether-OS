# Presentation & Handoff (Stage 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the seven Stage 7 presentation/handoff features from `docs/roadmap.md` §3.2: a "since you last looked" recap, out-of-app presence (badge/flash), presence suppression while focused, typed-reason notification sounds, model-written status headlines, roster grouping/glyph discipline, and a global transcript density control.

**Architecture:** `Notification` joins the existing Stage 6 permission HTTP server's hook group (`electron/permissionServer.ts`) for near-instant, session-scoped delivery. Main process reacts to it directly for badge/flash (real `BrowserWindow` APIs, main-process-only) and forwards it over IPC for sound, since `AudioContext` only exists in the renderer (`useAlertSounds.ts`'s existing pattern). A separate, focus-aware consumer of the existing `liveAgentTracker.tick()` stream (not a new data source) accumulates an in-memory recap, pushed once on refocus. Model-written headlines reuse the existing `chatCore.ts` pipeline with a Haiku-class model and a per-dispatch throttle. Roster grouping and transcript density are pure renderer-side logic modules consumed by existing cards.

**Tech Stack:** TypeScript, Node's built-in `http`/`node:sqlite`-free (no new backend dependency), Electron IPC + `BrowserWindow.flashFrame`/`setOverlayIcon`/`nativeImage`, React, Vitest, `@anthropic-ai/sdk` (already a dependency, reused for the headline call).

## Global Constraints

- **Session scope: Aether's own tracked session only** — the `Notification` hook script checks `session_id` against `own-session.json`, exactly like the existing `PermissionRequest`/`PostToolUse` branches in `scripts/aether-permission-hook.mjs`. A mismatch falls through non-blocking.
- **Notification hook is fire-and-forget** — unlike `PermissionRequest`/`PostToolUse`, there is no decision to wait for. The hook script POSTs and exits immediately; the server acks with 200 and an empty body.
- **Sound only plays in the renderer** — `AudioContext` (`src/shared/alertSounds.ts`) does not exist in the main process. Main process handles badge/flash directly (real `BrowserWindow` APIs) and forwards the notification reason to the renderer over IPC for `useAlertSounds.ts` to react to.
- **Suppression while focused is a true no-op** — `mainWindow.isFocused()` gates the *entire* handler. No badge, no flash, no IPC push, nothing recorded. This is simpler than partial tracking and still satisfies "don't klaxon when focused."
- **Recap is in-memory only** — resets on app restart, no persistence. `RecapAccumulator` lives in `electron/main.ts`'s module scope, reset after each push.
- **Overlay badge is a rendered presence indicator, not an exact digit count.** Rendering an accurate number requires either a heavy native `canvas` dependency or a hand-rolled bitmap font — out of proportion to this feature's value for a personal-cockpit app. This plan ships a single fixed dot/ring `NativeImage`, computed via pure pixel math (no new dependency, no static asset files), shown whenever the unfocused-notification count is > 0 and cleared on refocus. **This is a deliberate, flagged deviation from the design spec's literal "count badge" wording** — call this out to the user at plan review, since it's a real (if minor) scope trim from the approved spec.
- **Model-written headlines never block or error visibly.** A failed/timed-out Haiku call means the row keeps its local-derived default (`dispatch.description`) — never a spinner, never an error toast.
- **Haiku throttle: max once per 15s per `toolUseId` for periodic rewrites; the `blocked` trigger bypasses the throttle** (per the design spec, blocked headlines should feel immediate).
- **No PowerShell in any new hook/script code** — matches this repo's existing Node-only hook-script convention.
- Run `npx vitest run` (root) after every task. Run `npx tsc -b` before every commit.

---

### Task 1: `Notification` hook wiring end-to-end

**Files:**
- Modify: `electron/permissionServer.ts`
- Modify: `electron/permissionServer.test.ts`
- Modify: `scripts/aether-permission-hook.mjs`
- Modify: `collector/src/hookInstaller.ts`
- Modify: `collector/src/hookInstaller.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `StartPermissionServerOptions` gains `onNotification?: (req: { sessionId: string; notificationType: string }) => void`. Task 3 wires this callback in `main.ts`.

- [ ] **Step 1: Write the failing test for the new `/notification` route**

Add to `electron/permissionServer.test.ts`:

```ts
  it('calls onNotification and acks with 200 + empty body, fire-and-forget', async () => {
    const received: { sessionId: string; notificationType: string }[] = [];
    const started = await startPermissionServer({
      port: 0,
      timeoutMs: 5000,
      onPermissionRequest: async () => ({ behavior: 'allow' as const }),
      onNotification: (req) => {
        received.push(req);
      },
    });
    stop = started.stop;
    const res = await postJson(started.port, '/notification', { sessionId: 'abc', notificationType: 'agent_needs_input' });
    expect(res.status).toBe(200);
    expect(received).toEqual([{ sessionId: 'abc', notificationType: 'agent_needs_input' }]);
  });

  it('404s /notification when onNotification is not configured', async () => {
    const started = await startPermissionServer({
      port: 0,
      timeoutMs: 5000,
      onPermissionRequest: async () => ({ behavior: 'allow' as const }),
    });
    stop = started.stop;
    const res = await postJson(started.port, '/notification', { sessionId: 'abc', notificationType: 'agent_completed' });
    expect(res.status).toBe(404);
  });

  it('400s /notification with a malformed body', async () => {
    const started = await startPermissionServer({
      port: 0,
      timeoutMs: 5000,
      onPermissionRequest: async () => ({ behavior: 'allow' as const }),
      onNotification: () => {},
    });
    stop = started.stop;
    const res = await postJson(started.port, '/notification', { sessionId: 123, notificationType: null });
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run permissionServer.test.ts`
Expected: FAIL — `onNotification` doesn't exist, `/notification` 404s unconditionally.

- [ ] **Step 3: Implement the route**

In `electron/permissionServer.ts`, add to `StartPermissionServerOptions`:

```ts
  // Fire-and-forget: no decision to return, unlike onPermissionRequest/onPostToolUse.
  onNotification?: (req: { sessionId: string; notificationType: string }) => void;
```

Add a new branch at the top of the `http.createServer` callback (alongside the existing `/post-tool-flag-check` branch, before the `/permission-request` fallback check):

```ts
    if (req.method === 'POST' && req.url === '/notification') {
      if (!options.onNotification) {
        res.writeHead(404).end();
        return;
      }
      let notifParsed: { sessionId?: unknown; notificationType?: unknown };
      try {
        notifParsed = JSON.parse(await readBody(req));
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (typeof notifParsed.sessionId !== 'string' || typeof notifParsed.notificationType !== 'string') {
        res.writeHead(400).end();
        return;
      }
      try {
        options.onNotification({ sessionId: notifParsed.sessionId, notificationType: notifParsed.notificationType });
      } catch {
        // Same discipline as invokeSafely elsewhere in this file: a throwing
        // handler must never surface as a broken hook response.
      }
      res.writeHead(200).end();
      return;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run permissionServer.test.ts`
Expected: PASS, all tests green (existing + 3 new).

- [ ] **Step 5: Extend the hook script and installer**

In `collector/src/hookInstaller.ts`, change:

```ts
const PERMISSION_HOOK_EVENTS = ['PermissionRequest', 'PostToolUse'] as const;
```

to:

```ts
const PERMISSION_HOOK_EVENTS = ['PermissionRequest', 'PostToolUse', 'Notification'] as const;
```

In `collector/src/hookInstaller.test.ts`, find the existing test(s) asserting `installPermissionHooks` installs into `PermissionRequest`/`PostToolUse` and extend the assertion to also expect a `Notification` group with the same marker (read the existing test first to match its exact assertion style before editing — do not guess the shape).

In `scripts/aether-permission-hook.mjs`, add a fire-and-forget POST helper and a new branch in `main()`. Add this function alongside `postPermissionRequest`/`postToolFlagCheck`:

```js
// Fire-and-forget: no decision to wait for, so this only needs the short
// connect-timeout discipline (is the app even reachable), not the full
// DECISION_TIMEOUT_MS wait the other two routes need.
function postNotification(port, sessionId, notificationType) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const body = JSON.stringify({ sessionId, notificationType });
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/notification',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', done);
        res.on('error', done);
      }
    );
    req.on('error', done);
    const connectTimer = setTimeout(() => {
      req.destroy();
      done();
    }, CONNECT_TIMEOUT_MS);
    req.once('socket', (socket) => {
      socket.once('connect', () => clearTimeout(connectTimer));
    });
    req.end(body);
  });
}
```

Add a branch in `main()`, after the existing `session_id`/`port` resolution (before the `PostToolUse` branch, since `Notification` needs no `tool_name`):

```js
  if (payload.hook_event_name === 'Notification') {
    const notificationType = typeof payload.notification_type === 'string' ? payload.notification_type : null;
    if (!notificationType) return; // fall through: unusable payload
    await postNotification(port, sessionId, notificationType);
    return; // no stdout: Notification has no decision contract to honor
  }
```

Note this branch must come **before** the existing `if (!toolName) return;` unusable-payload guard further up, since `Notification` payloads have no `tool_name` field at all — read the current file structure first and place the branch correctly rather than assuming line numbers.

- [ ] **Step 6: Run the collector test suite**

Run (from `collector/`): `npm test`
Expected: PASS, including the extended `hookInstaller.test.ts` assertion.

- [ ] **Step 7: Commit**

```bash
git add electron/permissionServer.ts electron/permissionServer.test.ts scripts/aether-permission-hook.mjs collector/src/hookInstaller.ts collector/src/hookInstaller.test.ts
git commit -m "feat: add Notification hook route to the permission server and installer"
```

---

### Task 2: Sound extension — `playNotification` alert action

**Files:**
- Modify: `src/shared/alertSounds.ts`
- Modify: `src/shared/alertSounds.test.ts`
- Modify: `src/state/useAlertSounds.ts`
- Modify: `src/state/types.ts`
- Modify: `src/state/reducer.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/persistence.ts`

**Interfaces:**
- Consumes: nothing new from other Stage 7 tasks.
- Produces: `AlertAction` gains `{ kind: 'playNotification'; reason: NotificationReason }`; `AetherState` gains `lastNotification: { reason: NotificationReason; atMs: number } | null`; a new `SET_LAST_NOTIFICATION` reducer action. Task 3 dispatches this action from the `agents:notification` IPC push.

- [ ] **Step 1: Write the failing tests**

Add to `src/shared/alertSounds.test.ts`:

```ts
  it('does not emit playNotification from decideAlertActions (it is dispatched directly, not derived from alarmLevel/anomalyCount)', () => {
    // playNotification is triggered by a distinct state field (lastNotification),
    // not by decideAlertActions -- this test documents that boundary so a future
    // change doesn't accidentally fold it into the alarm/anomaly diff.
    const actions = decideAlertActions({ alarmLevel: 'ok', anomalyCount: 0 }, { alarmLevel: 'ok', anomalyCount: 0 });
    expect(actions.some((a) => a.kind === 'playNotification')).toBe(false);
  });
```

Add a new test file `src/shared/notificationSound.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toneForNotificationReason } from './alertSounds';

describe('toneForNotificationReason', () => {
  it('maps agent_needs_input to a distinct frequency', () => {
    expect(toneForNotificationReason('agent_needs_input')).toEqual({ frequencyHz: 660, durationSec: 0.18 });
  });
  it('maps agent_completed to a distinct frequency', () => {
    expect(toneForNotificationReason('agent_completed')).toEqual({ frequencyHz: 440, durationSec: 0.12 });
  });
  it('maps permission_prompt to a distinct frequency', () => {
    expect(toneForNotificationReason('permission_prompt')).toEqual({ frequencyHz: 880, durationSec: 0.25 });
  });
  it('falls back to a safe default tone for an unrecognized reason', () => {
    expect(toneForNotificationReason('something_new_from_a_future_claude_code_version')).toEqual({ frequencyHz: 550, durationSec: 0.15 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run alertSounds.test.ts notificationSound.test.ts`
Expected: FAIL — `toneForNotificationReason` doesn't exist.

- [ ] **Step 3: Implement**

In `src/shared/alertSounds.ts`, add the type and mapping function, and extend `AlertAction`:

```ts
export type NotificationReason = 'agent_needs_input' | 'agent_completed' | 'permission_prompt' | string;

export type AlertAction =
  | { kind: 'playYellow' }
  | { kind: 'startRed' }
  | { kind: 'stopRed' }
  | { kind: 'playAnomalyChime' }
  | { kind: 'playNotification'; reason: NotificationReason };

// One short synthesized tone per typed Notification reason -- reuses the
// existing playTone oscillator primitive below, no new audio asset.
// Unrecognized reasons (a future Claude Code version adding a new
// notification_type) get a safe default tone rather than silently playing
// nothing or throwing.
export function toneForNotificationReason(reason: NotificationReason): { frequencyHz: number; durationSec: number } {
  switch (reason) {
    case 'agent_needs_input':
      return { frequencyHz: 660, durationSec: 0.18 };
    case 'agent_completed':
      return { frequencyHz: 440, durationSec: 0.12 };
    case 'permission_prompt':
      return { frequencyHz: 880, durationSec: 0.25 };
    default:
      return { frequencyHz: 550, durationSec: 0.15 };
  }
}

export function playNotificationTone(reason: NotificationReason): void {
  const ctx = getAudioContext();
  const { frequencyHz, durationSec } = toneForNotificationReason(reason);
  playTone(ctx, frequencyHz, ctx.currentTime, durationSec, 0.15);
}
```

Add `lastNotification: { reason: NotificationReason; atMs: number } | null;` to `AetherState` in `src/state/types.ts` (import `NotificationReason` from `../shared/alertSounds`).

Add to `initialState.ts`: `lastNotification: null,`

Add to `reducer.ts`'s action union:

```ts
  | { type: 'SET_LAST_NOTIFICATION'; reason: NotificationReason }
```

and a case:

```ts
    case 'SET_LAST_NOTIFICATION':
      return { ...state, lastNotification: { reason: action.reason, atMs: Date.now() } };
```

Add an exclusion entry to `PERSISTENCE_EXCLUSIONS` in `persistence.ts` (matching the existing style — this is exactly the class of live/transient field that list already documents):

```ts
  lastNotification: 'a live IPC-pushed Notification-hook event used only to trigger a one-shot sound in useAlertSounds; a persisted value would replay a stale sound cue on the next launch',
```

In `src/state/useAlertSounds.ts`, add a new `useEffect` reacting to `state.lastNotification`:

```ts
  useEffect(() => {
    if (state.cfg.sound && state.lastNotification) {
      playNotificationTone(state.lastNotification.reason);
    }
    // Deliberately keyed on atMs, not the whole object reference, so two
    // notifications with the same reason in quick succession (e.g. two
    // permission_prompts) both trigger a fresh play instead of the second
    // being skipped by a same-value effect-dependency comparison.
  }, [state.lastNotification?.atMs, state.cfg.sound]);
```

and update the import line to include `playNotificationTone`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, full suite green (this touches shared state types other tests depend on).

- [ ] **Step 5: Commit**

```bash
git add src/shared/alertSounds.ts src/shared/alertSounds.test.ts src/shared/notificationSound.test.ts src/state/useAlertSounds.ts src/state/types.ts src/state/reducer.ts src/state/initialState.ts src/state/persistence.ts
git commit -m "feat: add typed Notification-reason sounds (playNotification)"
```

---

### Task 3: Presence — focus tracking, badge/flash, suppression

**Files:**
- Create: `electron/notificationBadge.ts`
- Create: `electron/notificationBadge.test.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`

**Interfaces:**
- Consumes: `startPermissionServer`'s `onNotification` (Task 1), `SET_LAST_NOTIFICATION` action (Task 2).
- Produces: `window.aetherElectron.agents.onNotification(callback)` in preload — a new IPC-reactive hook (folded into the existing `useRealAgentsSync.ts` in Task 3's own step, since it's the same "agents" namespace and the same file already holds four nearly-identical `onXxx` effects) dispatches `SET_LAST_NOTIFICATION`.

- [ ] **Step 1: Write the failing test for the badge renderer**

Create `electron/notificationBadge.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderNotificationBadge } from './notificationBadge';

describe('renderNotificationBadge', () => {
  it('returns a square RGBA buffer of the requested size', () => {
    const badge = renderNotificationBadge(16);
    expect(badge.width).toBe(16);
    expect(badge.height).toBe(16);
    expect(badge.buffer.length).toBe(16 * 16 * 4);
  });

  it('renders an opaque, non-transparent pixel at the center', () => {
    const badge = renderNotificationBadge(16);
    const centerIdx = (8 * 16 + 8) * 4;
    expect(badge.buffer[centerIdx + 3]).toBe(255); // alpha channel: fully opaque
  });

  it('renders a fully transparent pixel at the corner (outside the circle)', () => {
    const badge = renderNotificationBadge(16);
    const cornerIdx = (0 * 16 + 0) * 4;
    expect(badge.buffer[cornerIdx + 3]).toBe(0); // alpha channel: fully transparent
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run notificationBadge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure badge renderer**

Create `electron/notificationBadge.ts`:

```ts
// Renders a small filled-circle RGBA bitmap for BrowserWindow.setOverlayIcon()
// -- a presence indicator, not an exact count (see plan's Global Constraints:
// rendering an accurate digit needs either a native `canvas` dependency or a
// hand-rolled bitmap font, out of proportion to this feature's value here).
// Pure pixel math, no dependency, no static asset file.
export function renderNotificationBadge(size: number): { buffer: Buffer; width: number; height: number } {
  const buffer = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const radius = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - center;
      const dy = y - center;
      const inside = dx * dx + dy * dy <= radius * radius;
      const idx = (y * size + x) * 4;
      if (inside) {
        buffer[idx] = 214; // R -- matches the existing amber/red alert palette family
        buffer[idx + 1] = 40; // G
        buffer[idx + 2] = 40; // B
        buffer[idx + 3] = 255; // A: opaque
      } else {
        buffer[idx + 3] = 0; // A: transparent
      }
    }
  }
  return { buffer, width: size, height: size };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run notificationBadge.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Wire focus tracking, badge, flash, and sound-forwarding in `main.ts`**

Read `electron/main.ts`'s window-creation section and `sendToWindow` helper first (around the existing `win.on('maximize', ...)` calls) before editing, to place these additions consistently rather than guessing line numbers.

Add near the top of the file, alongside other simple module-scope state:

```ts
import { nativeImage } from 'electron';
import { renderNotificationBadge } from './notificationBadge';

let isWindowFocused = true;
let unfocusedNotificationCount = 0;
```

Inside `createWindow()`, after the existing `win.on('maximize', ...)`/`win.on('unmaximize', ...)` listeners:

```ts
  win.on('focus', () => {
    isWindowFocused = true;
    unfocusedNotificationCount = 0;
    win.flashFrame(false);
    win.setOverlayIcon(null, '');
  });
  win.on('blur', () => {
    isWindowFocused = false;
  });
```

Where the permission server is started (find the existing `startPermissionServer({...})` call), add the new callback:

```ts
    onNotification: ({ sessionId, notificationType }) => {
      if (sessionId !== readOwnSessionId(ownSessionFilePath)) return; // fleet noise, not us
      if (isWindowFocused) return; // suppression rule: true no-op while focused
      unfocusedNotificationCount += 1;
      win.flashFrame(true);
      const badge = renderNotificationBadge(16);
      win.setOverlayIcon(
        nativeImage.createFromBuffer(badge.buffer, { width: badge.width, height: badge.height }),
        `${unfocusedNotificationCount} notification${unfocusedNotificationCount === 1 ? '' : 's'} while away`
      );
      sendToWindow('agents:notification', { reason: notificationType });
    },
```

(`readOwnSessionId` and `ownSessionFilePath` already exist in this file for the `PermissionRequest`/`PostToolUse` callbacks — reuse them, do not re-derive.)

- [ ] **Step 6: Expose the new channel in `preload.ts` and consume it in `useRealAgentsSync.ts`**

In `electron/preload.ts`, add to the `agents` namespace:

```ts
    onNotification: (callback: (payload: { reason: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { reason: string }) => callback(payload);
      ipcRenderer.on('agents:notification', listener);
      return () => ipcRenderer.removeListener('agents:notification', listener);
    },
```

In `src/state/useRealAgentsSync.ts`, add one more effect alongside the existing four:

```ts
  useEffect(() => {
    const agents = window.aetherElectron?.agents;
    if (!agents) return;
    return agents.onNotification(({ reason }) => {
      dispatch({ type: 'SET_LAST_NOTIFICATION', reason });
    });
  }, [dispatch]);
```

- [ ] **Step 7: Run the full test suite and typecheck**

Run: `npx vitest run` and `npx tsc -b`.
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add electron/notificationBadge.ts electron/notificationBadge.test.ts electron/main.ts electron/preload.ts src/state/useRealAgentsSync.ts
git commit -m "feat: wire focus-aware presence (badge/flash) and notification-sound forwarding"
```

---

### Task 4: Recap accumulator + banner

**Files:**
- Create: `electron/recapAccumulator.ts`
- Create: `electron/recapAccumulator.test.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/state/types.ts`
- Modify: `src/state/reducer.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/persistence.ts`
- Modify: `src/state/useRealAgentsSync.ts`
- Create: `src/components/dashboard/RecapBanner.tsx`
- Create: `src/components/dashboard/RecapBanner.test.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `LiveAgentTick` shape (`electron/liveAgentTracker.ts`: `{ open, completed, work, anomalies, cacheHitRatio }`), `isWindowFocused` (Task 3).
- Produces: `RecapEntry`/`RecapAccumulator` types and `accumulate()`; `AetherState.recap: RecapPayload | null`; `RECAP_RECEIVED` / `DISMISS_RECAP` actions; `RecapBanner` component.

- [ ] **Step 1: Write the failing tests for `accumulate()`**

Create `electron/recapAccumulator.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createEmptyAccumulator, accumulate } from './recapAccumulator';
import type { LiveAgentTick } from './liveAgentTracker';

function tick(overrides: Partial<LiveAgentTick> = {}): LiveAgentTick {
  return { open: [], completed: [], work: [], anomalies: [], cacheHitRatio: 1, ...overrides };
}

describe('recapAccumulator.accumulate', () => {
  it('starts empty', () => {
    const acc = createEmptyAccumulator();
    expect(acc.entries).toEqual([]);
    expect(acc.tokensBurned).toBe(0);
  });

  it('records a dispatchCompleted entry when a new completed dispatch appears', () => {
    const prevTick = tick();
    const nextTick = tick({
      completed: [{ toolUseId: 't1', subagentType: 'general-purpose', description: 'do the thing', startedAt: '2026-01-01T00:00:00.000Z', prompt: 'x', model: null, tokens: 500, toolUses: 2, durationMs: 1000 }],
    });
    const acc = accumulate(createEmptyAccumulator(), nextTick, prevTick, Date.now());
    expect(acc.entries).toEqual([{ kind: 'dispatchCompleted', detail: 'general-purpose: do the thing', atMs: expect.any(Number) }]);
    expect(acc.tokensBurned).toBe(500);
  });

  it('records an anomalyDetected entry for a newly-seen anomaly toolUseId', () => {
    const prevTick = tick();
    const nextTick = tick({ anomalies: [{ kind: 'reReadLoop', toolUseId: 'a1', detail: 'foo.ts read 3 times' }] });
    const acc = accumulate(createEmptyAccumulator(), nextTick, prevTick, Date.now());
    expect(acc.entries).toEqual([{ kind: 'anomalyDetected', detail: 'foo.ts read 3 times', atMs: expect.any(Number) }]);
  });

  it('records an anomalyCleared entry when a previously-seen anomaly toolUseId disappears', () => {
    const prevTick = tick({ anomalies: [{ kind: 'reReadLoop', toolUseId: 'a1', detail: 'foo.ts read 3 times' }] });
    const nextTick = tick({ anomalies: [] });
    const acc = accumulate(createEmptyAccumulator(), nextTick, prevTick, Date.now());
    expect(acc.entries).toEqual([{ kind: 'anomalyCleared', detail: 'foo.ts read 3 times', atMs: expect.any(Number) }]);
  });

  it('does not re-record an anomaly still present in both ticks', () => {
    const anomaly = { kind: 'reReadLoop' as const, toolUseId: 'a1', detail: 'foo.ts read 3 times' };
    const prevTick = tick({ anomalies: [anomaly] });
    const nextTick = tick({ anomalies: [anomaly] });
    const acc = accumulate(createEmptyAccumulator(), nextTick, prevTick, Date.now());
    expect(acc.entries).toEqual([]);
  });

  it('accumulates across multiple calls rather than replacing', () => {
    let acc = createEmptyAccumulator();
    const nextTick1 = tick({ anomalies: [{ kind: 'reReadLoop', toolUseId: 'a1', detail: 'x' }] });
    acc = accumulate(acc, nextTick1, tick(), Date.now());
    const nextTick2 = tick({ anomalies: [] });
    acc = accumulate(acc, nextTick2, nextTick1, Date.now());
    expect(acc.entries).toHaveLength(2);
    expect(acc.entries.map((e) => e.kind)).toEqual(['anomalyDetected', 'anomalyCleared']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run recapAccumulator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `recapAccumulator.ts`**

```ts
import type { LiveAgentTick } from './liveAgentTracker';
import type { Anomaly } from '../src/shared/anomalyDetectors';
import type { CompletedDispatchUsage } from '../src/state/liveAgentsMath';

export interface RecapEntry {
  kind: 'dispatchCompleted' | 'anomalyDetected' | 'anomalyCleared';
  detail: string;
  atMs: number;
}

export interface RecapAccumulator {
  entries: RecapEntry[];
  tokensBurned: number;
}

export function createEmptyAccumulator(): RecapAccumulator {
  return { entries: [], tokensBurned: 0 };
}

function completedEntry(d: CompletedDispatchUsage, atMs: number): RecapEntry {
  return { kind: 'dispatchCompleted', detail: `${d.subagentType}: ${d.description}`, atMs };
}

// Diffs two consecutive tick() results and folds any newly-observable
// dispatch completions / anomaly transitions into the running accumulator.
// Pure -- callers (main.ts) are responsible for only invoking this while
// !isWindowFocused, and for resetting the accumulator on refocus.
export function accumulate(
  prevAcc: RecapAccumulator,
  nextTick: LiveAgentTick,
  prevTick: LiveAgentTick,
  nowMs: number
): RecapAccumulator {
  const entries = [...prevAcc.entries];
  let tokensBurned = prevAcc.tokensBurned;

  // completed[] is cumulative per liveAgentTracker's own contract (each tick
  // carries dispatches completed since the tracker started, not just this
  // tick) -- diff by toolUseId membership, not array length, matching the
  // existing established pattern in collector/src/anomalyIngest.ts.
  const prevCompletedIds = new Set(prevTick.completed.map((d) => d.toolUseId));
  for (const d of nextTick.completed) {
    if (!prevCompletedIds.has(d.toolUseId)) {
      entries.push(completedEntry(d, nowMs));
      tokensBurned += d.tokens;
    }
  }

  const prevAnomalyIds = new Map(prevTick.anomalies.map((a) => [a.toolUseId, a] as const));
  const nextAnomalyIds = new Map(nextTick.anomalies.map((a) => [a.toolUseId, a] as const));
  for (const [id, a] of nextAnomalyIds) {
    if (!prevAnomalyIds.has(id)) entries.push({ kind: 'anomalyDetected', detail: a.detail, atMs: nowMs });
  }
  for (const [id, a] of prevAnomalyIds) {
    if (!nextAnomalyIds.has(id)) entries.push({ kind: 'anomalyCleared', detail: a.detail, atMs: nowMs });
  }

  return { entries, tokensBurned };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run recapAccumulator.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Wire tick-diffing and the `presence:recap` push in `main.ts`**

Read the existing tick loop (`setInterval(tickAndPushAgents, AGENT_TICK_INTERVAL_MS)` and the function it calls) first to find where `tracker.tick()`'s result is already available, so the diff hooks into the real result rather than calling `tick()` twice.

Add module-scope state near the `isWindowFocused` additions from Task 3:

```ts
import { createEmptyAccumulator, accumulate, type RecapAccumulator } from './recapAccumulator';

let recapAcc: RecapAccumulator = createEmptyAccumulator();
let prevTickForRecap: LiveAgentTick | null = null;
```

Inside the existing per-tick function (wherever `const result = tracker.tick();` or equivalent already runs), add, right after that line:

```ts
  if (!isWindowFocused) {
    recapAcc = accumulate(recapAcc, result, prevTickForRecap ?? result, Date.now());
  }
  prevTickForRecap = result;
```

In the `win.on('focus', ...)` handler from Task 3, extend it to push and reset the recap (after the existing `flashFrame(false)`/`setOverlayIcon(null, '')` lines):

```ts
    if (recapAcc.entries.length > 0 || recapAcc.tokensBurned > 0) {
      sendToWindow('presence:recap', recapAcc);
    }
    recapAcc = createEmptyAccumulator();
```

- [ ] **Step 6: Add reducer state, preload expose, and the sync hook**

In `src/state/types.ts`, add:

```ts
export interface RecapPayload {
  entries: { kind: 'dispatchCompleted' | 'anomalyDetected' | 'anomalyCleared'; detail: string; atMs: number }[];
  tokensBurned: number;
}
```

and add `recap: RecapPayload | null;` to `AetherState`.

In `initialState.ts`: `recap: null,`

In `reducer.ts`'s action union:

```ts
  | { type: 'RECAP_RECEIVED'; recap: RecapPayload }
  | { type: 'DISMISS_RECAP' }
```

and cases:

```ts
    case 'RECAP_RECEIVED':
      return { ...state, recap: action.recap };
    case 'DISMISS_RECAP':
      return { ...state, recap: null };
```

In `persistence.ts`'s `PERSISTENCE_EXCLUSIONS`:

```ts
  recap: 'an in-memory-only "since you last looked" summary pushed once on refocus; persisting it would show a stale recap from a previous session on next launch, and this stage deliberately scopes recap to in-memory only',
```

In `electron/preload.ts`, add a new top-level `presence` namespace (not folded into `agents`, since this isn't dispatch-tracking data):

```ts
  presence: {
    onRecap: (callback: (recap: { entries: unknown[]; tokensBurned: number }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, recap: { entries: unknown[]; tokensBurned: number }) => callback(recap);
      ipcRenderer.on('presence:recap', listener);
      return () => ipcRenderer.removeListener('presence:recap', listener);
    },
  },
```

In `src/state/useRealAgentsSync.ts`, add one more effect (or note: if this file's name no longer fits now that it carries a non-agents concern, that's an acceptable, deliberate small drift — do not rename the file mid-task; a rename is out of scope here):

```ts
  useEffect(() => {
    const presence = window.aetherElectron?.presence;
    if (!presence) return;
    return presence.onRecap((recap) => {
      dispatch({ type: 'RECAP_RECEIVED', recap: recap as RecapPayload });
    });
  }, [dispatch]);
```

(Add `import type { RecapPayload } from './types';` at the top of the file.)

- [ ] **Step 7: Write the failing `RecapBanner` test**

Create `src/components/dashboard/RecapBanner.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RecapBanner } from './RecapBanner';

describe('RecapBanner', () => {
  it('renders nothing when recap is null', () => {
    const { container } = render(<RecapBanner recap={null} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('summarizes dispatch/anomaly counts and tokens burned', () => {
    render(
      <RecapBanner
        recap={{
          entries: [
            { kind: 'dispatchCompleted', detail: 'a', atMs: 1 },
            { kind: 'dispatchCompleted', detail: 'b', atMs: 2 },
            { kind: 'anomalyCleared', detail: 'c', atMs: 3 },
          ],
          tokensBurned: 42000,
        }}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText(/2 dispatches completed/)).toBeInTheDocument();
    expect(screen.getByText(/1 anomaly cleared/)).toBeInTheDocument();
    expect(screen.getByText(/42,000 tokens/)).toBeInTheDocument();
  });

  it('calls onDismiss when the close button is clicked', () => {
    const onDismiss = vi.fn();
    render(<RecapBanner recap={{ entries: [], tokensBurned: 100 }} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npx vitest run RecapBanner.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 9: Implement `RecapBanner.tsx`**

Read `src/components/agents/DispatchTimeline.tsx` or another small existing card first to match this codebase's `useColors()`/`fonts`/`Button` conventions before writing — do not invent a new styling approach.

```tsx
import { useEffect } from 'react';
import type { CSSProperties } from 'react';
import { fonts } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import type { RecapPayload } from '../../state/types';

const AUTO_DISMISS_MS = 10000;

export function RecapBanner({ recap, onDismiss }: { recap: RecapPayload | null; onDismiss: () => void }) {
  const colors = useColors();

  useEffect(() => {
    if (!recap) return;
    const id = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(id);
  }, [recap, onDismiss]);

  if (!recap) return null;

  const dispatchCount = recap.entries.filter((e) => e.kind === 'dispatchCompleted').length;
  const anomalyClearedCount = recap.entries.filter((e) => e.kind === 'anomalyCleared').length;
  const anomalyDetectedCount = recap.entries.filter((e) => e.kind === 'anomalyDetected').length;

  const parts: string[] = [];
  if (dispatchCount > 0) parts.push(`${dispatchCount} dispatch${dispatchCount === 1 ? '' : 'es'} completed`);
  if (anomalyDetectedCount > 0) parts.push(`${anomalyDetectedCount} anomal${anomalyDetectedCount === 1 ? 'y' : 'ies'} detected`);
  if (anomalyClearedCount > 0) parts.push(`${anomalyClearedCount} anomaly${anomalyClearedCount === 1 ? '' : ' each'} cleared`.replace('anomaly each cleared', 'anomalies cleared'));
  parts.push(`${recap.tokensBurned.toLocaleString()} tokens burned`);

  return (
    <div style={bannerStyle(colors)}>
      <span style={{ font: `400 12px/1.4 ${fonts.ui}`, color: colors.textBody }}>
        Since you last looked: {parts.join(', ')}.
      </span>
      <Button onClick={onDismiss} aria-label="dismiss recap" style={dismissStyle(colors)}>
        ✕
      </Button>
    </div>
  );
}

function bannerStyle(colors: { panelInset: string; chipBorder: string }): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '8px 14px',
    background: colors.panelInset,
    border: `1px solid ${colors.chipBorder}`,
    borderRadius: 6,
  };
}

function dismissStyle(colors: { textMuted: string }): CSSProperties {
  return { font: `400 12px/1 ${fonts.ui}`, color: colors.textMuted, padding: '2px 6px' };
}
```

Note: the exact `anomalyCleared` pluralization string-replace above is a placeholder shortcut for singular/plural — read it critically during implementation and simplify to whatever this codebase's existing pluralization helper (if any, e.g. check `utils/format.ts`) already provides, rather than the ad-hoc `.replace()` shown here if a cleaner helper exists.

Mount it in `src/App.tsx` alongside the other bare wrapper-hook components (read the existing mounting pattern there first):

```tsx
<RecapBanner recap={state.recap} onDismiss={() => dispatch({ type: 'DISMISS_RECAP' })} />
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, full suite green.

- [ ] **Step 11: Commit**

```bash
git add electron/recapAccumulator.ts electron/recapAccumulator.test.ts electron/main.ts electron/preload.ts src/state/types.ts src/state/reducer.ts src/state/initialState.ts src/state/persistence.ts src/state/useRealAgentsSync.ts src/components/dashboard/RecapBanner.tsx src/components/dashboard/RecapBanner.test.tsx src/App.tsx
git commit -m "feat: add since-you-last-looked recap accumulator and dismissible banner"
```

---

### Task 5: Model-written status headlines

**Files:**
- Modify: `src/shared/chatCore.ts`
- Modify: `src/shared/chatCore.test.ts`
- Create: `electron/headlineGenerator.ts`
- Create: `electron/headlineGenerator.test.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/state/types.ts`
- Modify: `src/state/reducer.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/persistence.ts`
- Modify: `src/state/useRealAgentsSync.ts`

**Interfaces:**
- Consumes: `runChatRequest` (extended), `onNotification` payload (Task 3, for the `blocked` trigger).
- Produces: `AetherState.dispatchHeadlines: Record<string, string>`; `SET_DISPATCH_HEADLINE` action. Task 6/7 read `state.dispatchHeadlines[toolUseId] ?? dispatch.description` as the effective headline.

- [ ] **Step 1: Parameterize `chatCore.ts`'s model (backward-compatible)**

Read `src/shared/chatCore.test.ts` first to see its existing mocking pattern before editing.

Change the `runChatRequest` signature to accept an optional model override, defaulting to the existing constant so every current call site (`main.ts`'s `chat:send` handler) needs no change:

```ts
export async function runChatRequest(
  body: unknown,
  apiKey: string | undefined,
  model: string = CHAT_MODEL,
  maxTokens: number = CHAT_MAX_TOKENS
): Promise<ChatCoreResult> {
```

and change the `client.messages.create` call's `model`/`max_tokens` fields to use the new parameters instead of the constants directly.

Add a test to `chatCore.test.ts` confirming the default still resolves to `CHAT_MODEL` (mock `Anthropic` the same way the existing tests do, and assert the mock was called with `model: CHAT_MODEL` when no override is passed, and with the override value when one is passed).

- [ ] **Step 2: Run chatCore tests**

Run: `npx vitest run chatCore.test.ts`
Expected: PASS (existing tests unaffected, new one green).

- [ ] **Step 3: Write the failing throttle-gate tests for `headlineGenerator.ts`**

Create `electron/headlineGenerator.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createHeadlineThrottle, shouldCallForHeadline } from './headlineGenerator';

describe('shouldCallForHeadline', () => {
  it('allows the first periodic call for a toolUseId', () => {
    const throttle = createHeadlineThrottle();
    expect(shouldCallForHeadline(throttle, 't1', 'periodic', 1000)).toBe(true);
  });

  it('blocks a second periodic call within 15s for the same toolUseId', () => {
    const throttle = createHeadlineThrottle();
    shouldCallForHeadline(throttle, 't1', 'periodic', 1000);
    expect(shouldCallForHeadline(throttle, 't1', 'periodic', 1000 + 14000)).toBe(false);
  });

  it('allows a periodic call again after 15s have elapsed', () => {
    const throttle = createHeadlineThrottle();
    shouldCallForHeadline(throttle, 't1', 'periodic', 1000);
    expect(shouldCallForHeadline(throttle, 't1', 'periodic', 1000 + 15001)).toBe(true);
  });

  it('does not throttle a different toolUseId', () => {
    const throttle = createHeadlineThrottle();
    shouldCallForHeadline(throttle, 't1', 'periodic', 1000);
    expect(shouldCallForHeadline(throttle, 't2', 'periodic', 1000)).toBe(true);
  });

  it('bypasses the throttle entirely for a blocked trigger, even immediately after a periodic call', () => {
    const throttle = createHeadlineThrottle();
    shouldCallForHeadline(throttle, 't1', 'periodic', 1000);
    expect(shouldCallForHeadline(throttle, 't1', 'blocked', 1001)).toBe(true);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run headlineGenerator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement the throttle gate and the real generator**

```ts
import { runChatRequest } from '../src/shared/chatCore';

export const HAIKU_MODEL = 'claude-haiku-4-5';
const PERIODIC_THROTTLE_MS = 15000;

export type HeadlineTrigger = 'periodic' | 'blocked';

export interface HeadlineThrottle {
  lastCallMsByToolUseId: Map<string, number>;
}

export function createHeadlineThrottle(): HeadlineThrottle {
  return { lastCallMsByToolUseId: new Map() };
}

// Pure gate: does NOT mutate the throttle or record the call -- callers
// (generateHeadline below) call this to decide whether to proceed, then
// separately record the call time only on an actual attempt. Kept pure and
// side-effect-free so it's trivially testable without faking a real request.
export function shouldCallForHeadline(
  throttle: HeadlineThrottle,
  toolUseId: string,
  trigger: HeadlineTrigger,
  nowMs: number
): boolean {
  if (trigger === 'blocked') return true; // never throttled -- see design spec
  const last = throttle.lastCallMsByToolUseId.get(toolUseId);
  return last === undefined || nowMs - last >= PERIODIC_THROTTLE_MS;
}

export function recordHeadlineCall(throttle: HeadlineThrottle, toolUseId: string, nowMs: number): void {
  throttle.lastCallMsByToolUseId.set(toolUseId, nowMs);
}

interface DispatchForHeadline {
  toolUseId: string;
  subagentType: string;
  description: string;
  prompt: string;
}

// Reuses the existing chat pipeline with a Haiku-class model rather than a
// parallel one. Never throws -- a failure returns null, and callers must
// keep the dispatch's local-derived default summary (dispatch.description)
// on null, per this stage's error-handling discipline.
export async function generateHeadline(
  dispatch: DispatchForHeadline,
  trigger: HeadlineTrigger,
  blockingContext: string | null,
  apiKey: string | undefined
): Promise<string | null> {
  const system =
    trigger === 'blocked'
      ? 'Rewrite the following into a single short (under 12 words) headline that states the actual question blocking this agent, not a generic "blocked" label. Reply with only the headline text, no punctuation wrapper.'
      : 'Rewrite the following into a single short (under 12 words) status headline for a dashboard row. Reply with only the headline text.';
  const userText = trigger === 'blocked' && blockingContext ? blockingContext : `${dispatch.subagentType}: ${dispatch.description}`;

  const result = await runChatRequest({ system, messages: [{ role: 'user', text: userText }] }, apiKey, HAIKU_MODEL, 40);
  if (!result.ok) return null;
  const trimmed = result.reply.trim();
  return trimmed.length > 0 ? trimmed : null;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run headlineGenerator.test.ts`
Expected: PASS, all 5 throttle tests green. (`generateHeadline` itself is integration-level and not unit-tested here, per the design spec's testing section — mirrors `chatCore.test.ts`'s existing mock-at-the-boundary convention if a test is added; a minimal one mocking `runChatRequest` is optional but not required to pass this task.)

- [ ] **Step 7: Wire state, IPC, and the two trigger points in `main.ts`**

In `src/state/types.ts`, add `dispatchHeadlines: Record<string, string>;` to `AetherState`.
In `initialState.ts`: `dispatchHeadlines: {},`
In `reducer.ts`:

```ts
  | { type: 'SET_DISPATCH_HEADLINE'; toolUseId: string; headline: string }
```

```ts
    case 'SET_DISPATCH_HEADLINE':
      return { ...state, dispatchHeadlines: { ...state.dispatchHeadlines, [action.toolUseId]: action.headline } };
```

In `persistence.ts`'s `PERSISTENCE_EXCLUSIONS`:

```ts
  dispatchHeadlines: 'model-written headlines keyed to live toolUseIds from the current session; a persisted value would attach a stale headline to a toolUseId that no longer exists after restart',
```

In `electron/main.ts`, add module-scope state near the other Stage 7 additions:

```ts
import { createHeadlineThrottle, shouldCallForHeadline, recordHeadlineCall, generateHeadline } from './headlineGenerator';

const headlineThrottle = createHeadlineThrottle();
```

**Periodic trigger**: inside the existing per-tick function (same location as Task 4's Step 5 diff hook), for each open dispatch:

```ts
  for (const d of result.open) {
    if (shouldCallForHeadline(headlineThrottle, d.toolUseId, 'periodic', Date.now())) {
      recordHeadlineCall(headlineThrottle, d.toolUseId, Date.now());
      generateHeadline(d, 'periodic', null, process.env.ANTHROPIC_API_KEY).then((headline) => {
        if (headline) sendToWindow('agents:headline', { toolUseId: d.toolUseId, headline });
      });
    }
  }
```

**Blocked trigger**: the real `Notification` hook payload is session-level (it does not carry a `tool_use_id` correlating to a specific subagent dispatch — confirm this against Claude Code's actual hook docs before implementing; if it turns out a correlating ID *is* present, prefer it over the fallback below and note the correction in this task's commit message, following this repo's own established "verify, then correct the plan in-flight" precedent from `docs/superpowers/plans/2026-07-28-closing-the-loop.md`'s Task 7 correction). Absent a real per-dispatch correlation, the defensible concrete choice is: apply the blocked headline to the most-recently-started currently-open dispatch, and skip entirely if none are open (nothing to attach a headline to). In the `onNotification` callback from Task 3, when `notificationType` is `'agent_needs_input'` or `'permission_prompt'`:

```ts
      if (notificationType === 'agent_needs_input' || notificationType === 'permission_prompt') {
        const mostRecentOpen = [...lastTickResult.open].sort(
          (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
        )[0];
        if (mostRecentOpen) {
          generateHeadline(mostRecentOpen, 'blocked', notificationType, process.env.ANTHROPIC_API_KEY).then((headline) => {
            if (headline) sendToWindow('agents:headline', { toolUseId: mostRecentOpen.toolUseId, headline });
          });
        }
      }
```

This reads `lastTickResult`, a small addition alongside `prevTickForRecap` from Task 4 Step 5 — add `let lastTickResult: LiveAgentTick | null = null;` next to it and set `lastTickResult = result;` at the same point `prevTickForRecap` is updated, so `onNotification` (which fires from the HTTP server callback, not the tick loop) has the latest tick snapshot available without calling `tracker.tick()` a second time.

- [ ] **Step 8: Expose `agents:headline` in preload and consume it**

In `preload.ts`'s `agents` namespace:

```ts
    onHeadline: (callback: (payload: { toolUseId: string; headline: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { toolUseId: string; headline: string }) => callback(payload);
      ipcRenderer.on('agents:headline', listener);
      return () => ipcRenderer.removeListener('agents:headline', listener);
    },
```

In `useRealAgentsSync.ts`:

```ts
  useEffect(() => {
    const agents = window.aetherElectron?.agents;
    if (!agents) return;
    return agents.onHeadline(({ toolUseId, headline }) => {
      dispatch({ type: 'SET_DISPATCH_HEADLINE', toolUseId, headline });
    });
  }, [dispatch]);
```

- [ ] **Step 9: Run the full test suite and typecheck**

Run: `npx vitest run` and `npx tsc -b`.
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add src/shared/chatCore.ts src/shared/chatCore.test.ts electron/headlineGenerator.ts electron/headlineGenerator.test.ts electron/main.ts electron/preload.ts src/state/types.ts src/state/reducer.ts src/state/initialState.ts src/state/persistence.ts src/state/useRealAgentsSync.ts
git commit -m "feat: add model-written status headlines (Haiku, throttled)"
```

---

### Task 6: Roster discipline — grouping and glyphs

**Files:**
- Create: `src/components/agents/rosterGrouping.ts`
- Create: `src/components/agents/rosterGrouping.test.ts`
- Modify: `src/components/agents/AgentRosterCard.tsx`

**Interfaces:**
- Consumes: `state.realAgents` (`RealAgentDispatch[]`), `state.anomalies` (`Anomaly[]`), `state.dispatchHeadlines` (Task 5).
- Produces: `groupDispatches(dispatches, anomalies): RosterGroup[]` where `RosterGroup = { label: 'NEEDS INPUT' | 'WORKING' | 'DONE'; dispatches: RealAgentDispatch[]; collapsible: boolean }`.

- [ ] **Step 1: Write the failing tests**

Create `src/components/agents/rosterGrouping.test.ts`. Read `src/components/agents/agentsMath.test.ts` first to match its exact fixture style before writing these.

```ts
import { describe, it, expect } from 'vitest';
import { groupDispatches } from './rosterGrouping';

const dispatch = (toolUseId: string) => ({
  toolUseId,
  subagentType: 'general-purpose',
  description: 'x',
  startedAt: '2026-01-01T00:00:00.000Z',
  prompt: 'x',
  model: null,
});

describe('groupDispatches', () => {
  it('places a dispatch with an active anomaly in NEEDS INPUT', () => {
    const groups = groupDispatches([dispatch('t1')], [{ kind: 'reReadLoop', toolUseId: 't1', detail: 'x' }]);
    const needsInput = groups.find((g) => g.label === 'NEEDS INPUT')!;
    expect(needsInput.dispatches.map((d) => d.toolUseId)).toEqual(['t1']);
  });

  it('places a dispatch with no anomaly in WORKING', () => {
    const groups = groupDispatches([dispatch('t1')], []);
    const working = groups.find((g) => g.label === 'WORKING')!;
    expect(working.dispatches.map((d) => d.toolUseId)).toEqual(['t1']);
  });

  it('orders NEEDS INPUT before WORKING before DONE, always, regardless of input order', () => {
    const groups = groupDispatches([dispatch('t1')], [{ kind: 'reReadLoop', toolUseId: 't1', detail: 'x' }]);
    expect(groups.map((g) => g.label)).toEqual(['NEEDS INPUT', 'WORKING', 'DONE']);
  });

  it('only DONE is ever collapsible', () => {
    const groups = groupDispatches([dispatch('t1')], [{ kind: 'reReadLoop', toolUseId: 't1', detail: 'x' }]);
    for (const g of groups) {
      expect(g.collapsible).toBe(g.label === 'DONE');
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run rosterGrouping.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Read `src/state/liveAgentsMath.ts`'s `RealAgentDispatch` and `src/shared/anomalyDetectors.ts`'s `Anomaly` types first to import the exact shapes rather than re-declaring them.

```ts
import type { RealAgentDispatch } from '../../state/liveAgentsMath';
import type { Anomaly } from '../../shared/anomalyDetectors';

export interface RosterGroup {
  label: 'NEEDS INPUT' | 'WORKING' | 'DONE';
  dispatches: RealAgentDispatch[];
  collapsible: boolean;
}

// state.realAgents only ever carries currently-open dispatches (see
// useRealAgentsSync's SET_REAL_AGENTS wiring) -- there is no "done but still
// shown" dispatch in this array today, so the DONE group is always empty
// until/unless a future stage feeds completed-but-recently-visible dispatches
// into this function. It's still modeled explicitly (not omitted) because the
// design spec's survival rule is specifically about DONE being the only
// collapsible group -- that rule needs a group to apply to even if it's
// empty today.
export function groupDispatches(dispatches: RealAgentDispatch[], anomalies: Anomaly[]): RosterGroup[] {
  const anomalyToolUseIds = new Set(anomalies.map((a) => a.toolUseId));
  const needsInput = dispatches.filter((d) => anomalyToolUseIds.has(d.toolUseId));
  const working = dispatches.filter((d) => !anomalyToolUseIds.has(d.toolUseId));

  return [
    { label: 'NEEDS INPUT', dispatches: needsInput, collapsible: false },
    { label: 'WORKING', dispatches: working, collapsible: false },
    { label: 'DONE', dispatches: [], collapsible: true },
  ];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run rosterGrouping.test.ts`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Rework `AgentRosterCard.tsx`**

Read the current full file (already quoted in the design spec's context-gathering) before editing. Replace the flat `state.realAgents.map(...)` block with grouped rendering:

```tsx
import { groupDispatches } from './rosterGrouping';

// ...inside the component, before the return:
const groups = groupDispatches(state.realAgents, state.anomalies);

// ...replacing the existing flat map with:
{groups.map((group) => (
  group.dispatches.length > 0 && (
    <div key={group.label}>
      <div style={groupHeaderStyle(colors)}>{group.label}</div>
      {group.dispatches.map((a) => {
        const on = a.toolUseId === selectedToolUseId;
        const hasAnomaly = group.label === 'NEEDS INPUT';
        const headline = state.dispatchHeadlines[a.toolUseId] ?? a.description;
        return (
          <Button key={a.toolUseId} onClick={() => dispatch({ type: 'SELECT_REAL_AGENT', toolUseId: a.toolUseId })} style={rowStyle(on)}>
            <span style={glyphStyle(colors, hasAnomaly)} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={nameStyle(colors)}>{a.subagentType}</span>
                <span style={{ font: `700 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>{fmtElapsed(now - new Date(a.startedAt).getTime())}</span>
              </div>
              <div style={descStyle(colors)}>{headline}</div>
            </div>
          </Button>
        );
      })}
    </div>
  )
))}
{!state.realAgents.length && <div style={emptyStyle(colors)}>no agents currently running</div>}
```

Add `glyphStyle` and `groupHeaderStyle`, replacing the old two-letter `avatarStyle` avatar entirely (the two-axis glyph: colour = state via `hasAnomaly`, shape = a solid dot for a live process — this stage has no "completed but shown" dispatch per Step 3's note, so the hollow-ring liveness variant has no real data to drive it yet and is deliberately not implemented speculatively; only the anomaly-ring axis is real today):

```ts
function glyphStyle(colors: ColorPalette, hasAnomaly: boolean): CSSProperties {
  return {
    width: 10,
    height: 10,
    borderRadius: '50%',
    flex: 'none',
    background: colors.accentCyanSoft,
    boxShadow: hasAnomaly ? `0 0 0 2px ${colors.warn}` : 'none',
  };
}

function groupHeaderStyle(colors: ColorPalette): CSSProperties {
  return { font: `700 10px/1 ${fonts.ui}`, letterSpacing: 1.5, color: colors.textMuted, margin: '10px 0 4px' };
}
```

(Verify `colors.warn` is the correct existing token name in `src/styles/tokens.ts` before using it — read that file's `ColorPalette` interface first rather than assuming the name.)

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `npx vitest run` and `npx tsc -b`.
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/components/agents/rosterGrouping.ts src/components/agents/rosterGrouping.test.ts src/components/agents/AgentRosterCard.tsx
git commit -m "feat: group AgentRosterCard by state with anomaly-ring glyphs"
```

---

### Task 7: Transcript density control

**Files:**
- Create: `src/shared/transcriptDensity.ts`
- Create: `src/shared/transcriptDensity.test.ts`
- Modify: `src/state/types.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/components/settings/AppearanceCard.tsx` (or a new small settings card if this one is judged too crowded — read it in full first and decide; do not guess)
- Modify: `src/components/agents/AgentDetailCard.tsx`
- Modify: `src/components/agents/AgentRosterCard.tsx`
- Modify: `src/components/memory/MemoryDetailCard.tsx`

**Interfaces:**
- Consumes: `state.dispatchHeadlines` (Task 5), `Cfg` (extended here).
- Produces: `applyDensity(fullContent, level, headline): string`; `Cfg.densityLevel: 'normal' | 'verbose' | 'summary'`.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/transcriptDensity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applyDensity } from './transcriptDensity';

describe('applyDensity', () => {
  it('passes full content through unchanged at normal', () => {
    expect(applyDensity('the full prompt text', 'normal', 'a headline')).toBe('the full prompt text');
  });

  it('passes full content through unchanged at verbose', () => {
    expect(applyDensity('the full prompt text', 'verbose', 'a headline')).toBe('the full prompt text');
  });

  it('collapses to the headline alone at summary', () => {
    expect(applyDensity('the full prompt text', 'summary', 'a headline')).toBe('a headline');
  });

  it('falls back to the full content at summary when no headline is available', () => {
    expect(applyDensity('the full prompt text', 'summary', null)).toBe('the full prompt text');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run transcriptDensity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export type DensityLevel = 'normal' | 'verbose' | 'summary';

// One shared collapse rule for every Summary-density consumer (AgentDetailCard's
// prompt, roster rows, Memory's dispatch entries) -- not three separate
// implementations. Falls back to the full content if no headline exists yet
// (e.g. the Haiku call hasn't landed or failed), so Summary never shows blank.
export function applyDensity(fullContent: string, level: DensityLevel, headline: string | null): string {
  if (level !== 'summary') return fullContent;
  return headline ?? fullContent;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run transcriptDensity.test.ts`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Add `densityLevel` to `Cfg` and the Settings toggle**

In `src/state/types.ts`'s `Cfg` interface, add: `densityLevel: 'normal' | 'verbose' | 'summary';`
In `initialState.ts`'s `cfg` object: `densityLevel: 'normal',`

Read `src/components/settings/AppearanceCard.tsx` in full (its existing `pulseMode`/`theme` toggle rendering, already partially quoted during design) and add a matching three-way toggle following its exact existing button-row pattern:

```tsx
<div style={rowLabelStyle(colors)}>TRANSCRIPT DENSITY</div>
<div style={toggleRowStyle}>
  {(['normal', 'verbose', 'summary'] as const).map((level) => (
    <Button
      key={level}
      onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { densityLevel: level } })}
      style={toggleStyle(colors, cfg.densityLevel === level)}
    >
      {level.toUpperCase()}
    </Button>
  ))}
</div>
```

(Match `rowLabelStyle`/`toggleRowStyle`/`toggleStyle` to whatever this file's existing helper functions are actually named — read them first, do not assume these exact names exist; reuse if they do, or add minimal equivalents following the same visual pattern if this is the first toggle row of its kind in the file.)

- [ ] **Step 6: Wire density into the three consumers**

In `src/components/agents/AgentDetailCard.tsx`, replace:

```tsx
<div style={promptTextStyle(colors)}>{agent.prompt || 'no prompt text available'}</div>
```

with:

```tsx
<div style={promptTextStyle(colors)}>
  {applyDensity(agent.prompt, state.cfg.densityLevel, state.dispatchHeadlines[agent.toolUseId] ?? null) || 'no prompt text available'}
</div>
```

(add the `applyDensity` import and confirm `state` is already in scope in this component — it reads `useAetherStore()` already per the file's existing structure quoted earlier).

In `src/components/agents/AgentRosterCard.tsx`, the `headline` line from Task 6 already reads `state.dispatchHeadlines[a.toolUseId] ?? a.description` — at `summary` density this is already the desired behavior (headline-only) with no further change needed; at `normal`/`verbose` it should show `a.description` when no headline exists yet, which it already does. **No change needed here beyond Task 6's existing line** — note this explicitly rather than adding a redundant `applyDensity` call that would do nothing new.

In `src/components/memory/MemoryDetailCard.tsx`, replace:

```tsx
<div style={{ marginTop: 8, font: `400 13px/1.6 ${fonts.ui}`, color: colors.textBody }}>{memory.content}</div>
```

with:

```tsx
<div style={{ marginTop: 8, font: `400 13px/1.6 ${fonts.ui}`, color: colors.textBody }}>
  {applyDensity(memory.content, state.cfg.densityLevel, memory.name)}
</div>
```

(`memory.name` is already a short label per `MemoryStub`'s shape, used here as the "headline" for Summary density — add the `applyDensity` import and confirm `state.cfg` is reachable in this component's existing `useAetherStore()` call.)

- [ ] **Step 7: Run the full test suite and typecheck**

Run: `npx vitest run` and `npx tsc -b`.
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/shared/transcriptDensity.ts src/shared/transcriptDensity.test.ts src/state/types.ts src/state/initialState.ts src/components/settings/AppearanceCard.tsx src/components/agents/AgentDetailCard.tsx src/components/memory/MemoryDetailCard.tsx
git commit -m "feat: add global transcript density control (Normal/Verbose/Summary)"
```

---

### Task 8: Roadmap/PROGRESS closeout

**Files:**
- Modify: `README.md` (only if a live screenshot/GIF is actually feasible — this repo now has a real display, unlike the headless environment Stage 4/5/6 were built in; attempt it for real rather than repeating the deferral disclaimer by default)
- Modify: `docs/roadmap.md`
- Modify: `PROGRESS.md`

- [ ] **Step 1: Attempt a live screenshot of the new roster grouping/glyphs and, if feasible, a short recap-banner GIF.** This machine has a real Windows display (confirmed working earlier this project's history — see `docs/portfolio-optimize-cost-of-thrash.png`/`docs/portfolio-cost-of-thrash-live.gif` already in this repo from that effort). Launch `npm run electron:dev`, drive a real dispatch and a real unfocus/refocus cycle, and capture what's actually on screen. If any piece is genuinely infeasible (e.g. can't trigger a real `Notification` hook event without a live external Claude Code session), name that specific gap plainly rather than deferring the whole task.

- [ ] **Step 2: Update `docs/roadmap.md`'s Stage 7 row** to `**Status: shipped**`, matching the Stage 3/4/5/6 phrasing convention, pointing to this plan file, with the overlay-badge simplification (dot, not exact count) named plainly as a deferred/simplified item, not silently dropped.

- [ ] **Step 3: Add a `PROGRESS.md` entry** following the established convention: what shipped (Notification-hook-driven presence with focus suppression, typed-reason sounds, in-memory recap banner, Haiku-written headlines with a blocked-vs-periodic throttle split, grouped/glyphed roster, global density control), what's simplified from the original spec (the badge is a presence dot, not a rendered digit count — named plainly, with the reasoning from this plan's Global Constraints), and what's still open (the blocked-trigger headline call's dispatch-correlation gap from Task 5 Step 7, if it turned out the real `Notification` payload doesn't carry one).

- [ ] **Step 4: Final whole-repo verification pass**

Run from repo root: `npx tsc -b`, `npm run build`, `npx vitest run`. Run from `collector/`: `npm run build`, `npm test`.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/roadmap.md PROGRESS.md
git commit -m "docs: Stage 7 (Presentation & Handoff) shipped — roadmap/PROGRESS closeout"
```
