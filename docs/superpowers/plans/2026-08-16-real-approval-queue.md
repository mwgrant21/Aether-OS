# Real Approval Queue & Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace aether-os's fictional approval-queue/notification data (a hardcoded random generator in `tick.ts`) with real events from the app's existing permission pipeline, and add a configurable auto-allow threshold so low-risk real permission requests no longer require a manual click.

**Architecture:** aether-os already has a real, working permission pipeline (`electron/permissionServer.ts` + `main.ts`'s `onPermissionRequest`/`onPostToolUse`, surfaced via `state.pendingPermissionRequest`/`state.pendingPostToolFlag` and rendered by `PermissionRequestCard.tsx`/`PostToolFlagCard.tsx`). This plan (1) adds a risk threshold so `main.ts` auto-allows requests at/below it before ever prompting, (2) makes `reducer.ts` push real notification entries for permission/anomaly/dispatch events instead of `tick.ts`'s random ones, (3) removes the entirely-fictional `Approval`/`state.approvals` system and its `tick.ts` spawn generator, and (4) migrates the three Terminal commands that referenced it (`approvals`/`approve`/`deny` — confirmed unreachable from any live UI element today) onto the real pending-request state.

**Tech Stack:** TypeScript, React, Electron (main + renderer + preload IPC), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-real-approval-queue-design.md` (read the Addendum section — it supersedes the original Goals #1/#3 wording with full-removal + Terminal migration, confirmed lower-risk than it sounds because those three Terminal commands are dead code today).

## Global Constraints

- Default auto-allow threshold: `LOW_MED` (per spec's user-confirmed choice) — Read/Grep/Glob (LOW) and Write/Edit/most Bash (MED) auto-allow; destructive Bash (HIGH, per `classifyPermissionRisk`'s `HIGH_RISK_BASH_PATTERN`) always prompts.
- `runCommand` in `commands.ts` is otherwise a pure function of `state` — Task 12 is the one deliberate exception (it calls `window.aetherElectron` directly), and that exception must not spread to any other command.
- Every task ends with `npx vitest run` passing for the files it touches, plus a commit. Do not batch commits across tasks.
- This repo's tests run via Vitest; command shown per task assumes repo root `C:\Users\Matt\projects\aether-os`.

---

### Task 1: Add the `permissionAutoAllow` config field

**Files:**
- Modify: `src/shared/permissionRisk.ts`
- Modify: `src/state/types.ts:219-236` (`Cfg` interface)
- Modify: `src/state/initialState.ts:43-68` (`cfg` object)
- Test: `src/shared/permissionRisk.test.ts` (new — check if it already exists first; if so add to it)

**Interfaces:**
- Produces: `PermissionAutoAllowLevel` type (`'NONE' | 'LOW' | 'LOW_MED'`), exported from `src/shared/permissionRisk.ts`, consumed by Task 2 (`shouldAutoAllow`), Task 3 (`main.ts`), Task 5 (settings UI).
- Produces: `Cfg.permissionAutoAllow: PermissionAutoAllowLevel`, default `'LOW_MED'`.

- [ ] **Step 1: Check for an existing permissionRisk test file**

Run: `ls src/shared/permissionRisk.test.ts 2>/dev/null || echo "no existing test file"`

- [ ] **Step 2: Add the type to `permissionRisk.ts`**

In `src/shared/permissionRisk.ts`, add below the existing `PermissionRisk` type:

```typescript
export type PermissionAutoAllowLevel = 'NONE' | 'LOW' | 'LOW_MED';
```

- [ ] **Step 3: Add the field to `Cfg` in `types.ts`**

In `src/state/types.ts`, add the import and field:

```typescript
import type { PermissionRisk, PermissionAutoAllowLevel } from '../shared/permissionRisk';
```

(this replaces the existing `import type { PermissionRisk } from '../shared/permissionRisk';` line at `types.ts:95`)

In the `Cfg` interface (`types.ts:219-236`), add:

```typescript
  permissionAutoAllow: PermissionAutoAllowLevel;
```

- [ ] **Step 4: Add the default to `initialState.ts`**

In `src/state/initialState.ts`, inside the `cfg` object (after `autoThrottle: true,` at line 54), add:

```typescript
    permissionAutoAllow: 'LOW_MED',
```

- [ ] **Step 5: Run the existing type-checking test suite to confirm no breakage**

Run: `npx vitest run src/state`
Expected: PASS (no test currently asserts on `Cfg`'s exact key set, so this should be a no-op change from the test suite's perspective)

- [ ] **Step 6: Commit**

```bash
git add src/shared/permissionRisk.ts src/state/types.ts src/state/initialState.ts
git commit -m "feat: add permissionAutoAllow config field"
```

---

### Task 2: Add `shouldAutoAllow` risk-threshold helper

**Files:**
- Modify: `src/shared/permissionRisk.ts`
- Test: `src/shared/permissionRisk.test.ts`

**Interfaces:**
- Consumes: `PermissionRisk` (`'LOW' | 'MED' | 'HIGH'`), `PermissionAutoAllowLevel` (`'NONE' | 'LOW' | 'LOW_MED'`) — both from Task 1.
- Produces: `shouldAutoAllow(risk: PermissionRisk, threshold: PermissionAutoAllowLevel): boolean`, consumed by Task 3 (`main.ts`).

- [ ] **Step 1: Write the failing tests**

Create/extend `src/shared/permissionRisk.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { shouldAutoAllow } from './permissionRisk';

describe('shouldAutoAllow', () => {
  it('NONE threshold never auto-allows, regardless of risk', () => {
    expect(shouldAutoAllow('LOW', 'NONE')).toBe(false);
    expect(shouldAutoAllow('MED', 'NONE')).toBe(false);
    expect(shouldAutoAllow('HIGH', 'NONE')).toBe(false);
  });

  it('LOW threshold auto-allows only LOW risk', () => {
    expect(shouldAutoAllow('LOW', 'LOW')).toBe(true);
    expect(shouldAutoAllow('MED', 'LOW')).toBe(false);
    expect(shouldAutoAllow('HIGH', 'LOW')).toBe(false);
  });

  it('LOW_MED threshold auto-allows LOW and MED, never HIGH', () => {
    expect(shouldAutoAllow('LOW', 'LOW_MED')).toBe(true);
    expect(shouldAutoAllow('MED', 'LOW_MED')).toBe(true);
    expect(shouldAutoAllow('HIGH', 'LOW_MED')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/permissionRisk.test.ts`
Expected: FAIL with "shouldAutoAllow is not a function" or similar

- [ ] **Step 3: Implement `shouldAutoAllow`**

Add to `src/shared/permissionRisk.ts`:

```typescript
export function shouldAutoAllow(risk: PermissionRisk, threshold: PermissionAutoAllowLevel): boolean {
  if (threshold === 'NONE') return false;
  if (threshold === 'LOW') return risk === 'LOW';
  return risk === 'LOW' || risk === 'MED';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/permissionRisk.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/permissionRisk.ts src/shared/permissionRisk.test.ts
git commit -m "feat: add shouldAutoAllow risk-threshold helper"
```

---

### Task 3: Wire auto-allow into `main.ts`'s real permission handler

**Files:**
- Modify: `electron/main.ts:629-645` (`onPermissionRequest`)
- Modify: `electron/main.ts` (module-level state, near existing `autoHeadlinesEnabled`/`crossEngineFeatureEnabled` declarations)
- Modify: `electron/preload.ts:198-205` (`permission` bridge)

**Interfaces:**
- Consumes: `shouldAutoAllow` from Task 2, `classifyPermissionRisk` (already imported in `main.ts`).
- Produces: `window.aetherElectron.permission.setAutoAllow(level: PermissionAutoAllowLevel): void`, consumed by Task 4.

- [ ] **Step 1: Add the module-level threshold variable in `main.ts`**

Near the existing `let autoHeadlinesEnabled = ...` declaration (search for it — it's set by the `agents:setAutoHeadlines` handler at `main.ts:742-744`), add:

```typescript
let permissionAutoAllowThreshold: PermissionAutoAllowLevel = 'LOW_MED';
```

Add the import at the top of `main.ts` alongside the existing `classifyPermissionRisk` import:

```typescript
import { classifyPermissionRisk, shouldAutoAllow, type PermissionAutoAllowLevel } from '../src/shared/permissionRisk';
```

(adjust to match however `classifyPermissionRisk` is currently imported — combine into one import statement rather than adding a second one)

- [ ] **Step 2: Auto-allow before prompting, in `onPermissionRequest`**

In `electron/main.ts`, replace the `onPermissionRequest` callback (currently `main.ts:629-645`):

```typescript
    onPermissionRequest: async (req: { toolName: string; toolInput: unknown }): Promise<PermissionDecision> => {
      const risk = classifyPermissionRisk(req.toolName, req.toolInput);
      if (shouldAutoAllow(risk, permissionAutoAllowThreshold)) {
        return { behavior: 'allow' };
      }
      // Bridges the permission server's request to the renderer and back.
      // This resolution map lives here (not in permissionServer.ts) because
      // it's specifically about the renderer round-trip, not the HTTP server
      // itself -- permissionServer.ts's own withTimeout already covers the
      // "no decision in time" case around this call.
      if (!mainWindow) return { behavior: 'deny', reason: 'no window available to prompt for permission' };
      const requestId = crypto.randomUUID();
      const editableField = derivePermissionEditableField(req.toolName, req.toolInput);
      const decision = new Promise<PermissionDecision>((resolve) => {
        pendingPermissionResolvers.set(requestId, resolve);
      });
      scheduleResolverCleanup(pendingPermissionResolvers, requestId, permissionServerOptions.timeoutMs);
      sendToWindow('permission:request', { requestId, toolName: req.toolName, toolInput: req.toolInput, risk, editableField });
      return decision;
    },
```

- [ ] **Step 3: Add the IPC handler to receive the threshold from the renderer**

Near the existing `ipcMain.on('agents:setAutoHeadlines', ...)` handler (`main.ts:742-744`), add:

```typescript
ipcMain.on('permission:setAutoAllow', (_event, level: PermissionAutoAllowLevel) => {
  permissionAutoAllowThreshold = level;
});
```

- [ ] **Step 4: Expose the setter in `preload.ts`**

In `electron/preload.ts`, inside the `permission` object (`preload.ts:198-205`), add:

```typescript
    setAutoAllow: (level: PermissionAutoAllowLevel) => ipcRenderer.send('permission:setAutoAllow', level),
```

Add the type import at the top of `preload.ts` alongside the existing `PermissionRequestUI`/`PostToolFlagRequestUI` import:

```typescript
import type { PermissionAutoAllowLevel } from '../src/shared/permissionRisk';
```

- [ ] **Step 5: Run the permission server test suite to confirm no regression**

Run: `npx vitest run electron/permissionServer.test.ts`
Expected: PASS (these tests supply their own mock `onPermissionRequest`, so `main.ts`'s specific auto-allow logic isn't exercised here — that's covered by Task 2's unit tests on `shouldAutoAllow` directly; `main.ts` itself has no existing direct test harness, consistent with its other inline IPC glue like `autoHeadlinesEnabled`)

- [ ] **Step 6: Commit**

```bash
git add electron/main.ts electron/preload.ts
git commit -m "feat: auto-allow real permission requests at/below the configured risk threshold"
```

---

### Task 4: Push the threshold from renderer to main

**Files:**
- Create: `src/state/usePermissionAutoAllowSync.ts`
- Modify: `src/App.tsx` (register the new sync hook alongside `useRealAgentsSync` and similar)

**Interfaces:**
- Consumes: `window.aetherElectron.permission.setAutoAllow` from Task 3, `state.cfg.permissionAutoAllow` from Task 1.
- Produces: nothing new consumed elsewhere — this is a leaf sync hook.

- [ ] **Step 1: Find the existing hook-registration pattern**

Run: `grep -n "useRealAgentsSync\|useStatuslineSync\|useLedgerSync" src/App.tsx`

- [ ] **Step 2: Write the sync hook**

Create `src/state/usePermissionAutoAllowSync.ts`:

```typescript
import { useEffect } from 'react';
import { useAetherStore } from './store';

// Pushes the current threshold to main on every mount (covers app restart,
// where main.ts always starts with its own default until told otherwise)
// and on every change -- same pattern OperatingModeCard.tsx already uses for
// autoHeadlines.
export function usePermissionAutoAllowSync() {
  const { state } = useAetherStore();
  const { permissionAutoAllow } = state.cfg;

  useEffect(() => {
    window.aetherElectron?.permission.setAutoAllow(permissionAutoAllow);
  }, [permissionAutoAllow]);
}
```

- [ ] **Step 3: Register the hook in `App.tsx`**

In `src/App.tsx`, alongside the existing `useRealAgentsSync()` call (or similar top-level sync hook calls), add:

```typescript
usePermissionAutoAllowSync();
```

And the import:

```typescript
import { usePermissionAutoAllowSync } from './state/usePermissionAutoAllowSync';
```

- [ ] **Step 4: Run the app's existing App-level tests to confirm no breakage**

Run: `npx vitest run src/App.recapBanner.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/state/usePermissionAutoAllowSync.ts src/App.tsx
git commit -m "feat: sync permissionAutoAllow threshold from renderer to main"
```

---

### Task 5: Add the settings UI toggle

**Files:**
- Modify: `src/components/settings/OperatingModeCard.tsx`
- Test: `src/components/settings/OperatingModeCard.test.tsx` (new — check if a test file already exists for this component first)

**Interfaces:**
- Consumes: `state.cfg.permissionAutoAllow`, `UPDATE_CFG` action (already exists in `reducer.ts:188-189`, generic — no reducer change needed).

- [ ] **Step 1: Check for an existing test file**

Run: `ls src/components/settings/OperatingModeCard.test.tsx 2>/dev/null || echo "no existing test file"`

- [ ] **Step 2: Add the three-way toggle to `OperatingModeCard.tsx`**

In `src/components/settings/OperatingModeCard.tsx`, add below the existing "AUTO HEADLINES" toggle block (after line 48's closing `</div>` and its `hintStyle` div):

```tsx
      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle(colors)}>PERMISSION AUTO-ALLOW</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['NONE', 'LOW', 'LOW_MED'] as const).map((level) => (
            <Button
              key={level}
              onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { permissionAutoAllow: level } })}
              style={toggleStyle(colors, state.cfg.permissionAutoAllow === level)}
            >
              {level === 'LOW_MED' ? 'LOW+MED' : level}
            </Button>
          ))}
        </div>
      </div>
      <div style={hintStyle(colors)}>
        Real permission requests at or below this risk level are allowed automatically, with no
        prompt. Requests above it (destructive Bash at NONE/LOW/LOW_MED, or everything at NONE)
        still require a manual Approve/Deny.
      </div>
```

- [ ] **Step 3: Write a render test**

Create `src/components/settings/OperatingModeCard.test.tsx` (or add to it if it exists) — pattern confirmed against `src/components/settings/NarrationVerbosityCard.test.tsx`, an existing sibling test using the same three-way-toggle shape:

```typescript
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { OperatingModeCard } from './OperatingModeCard';
import { AetherStoreProvider } from '../../state/store';

afterEach(cleanup);

describe('OperatingModeCard permission auto-allow toggle', () => {
  it('shows LOW+MED as active by default', () => {
    render(
      <AetherStoreProvider>
        <OperatingModeCard />
      </AetherStoreProvider>,
    );
    const lowMedButton = screen.getByText('LOW+MED');
    expect(lowMedButton.style.background).toContain('linear-gradient');
  });

  it('clicking NONE updates cfg.permissionAutoAllow', () => {
    render(
      <AetherStoreProvider>
        <OperatingModeCard />
      </AetherStoreProvider>,
    );
    fireEvent.click(screen.getByText('NONE'));

    const noneButton = screen.getByText('NONE');
    const lowMedButton = screen.getByText('LOW+MED');
    expect(noneButton.style.background).toContain('linear-gradient');
    expect(lowMedButton.style.background).not.toContain('linear-gradient');
  });
});
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/components/settings/OperatingModeCard.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/OperatingModeCard.tsx src/components/settings/OperatingModeCard.test.tsx
git commit -m "feat: add permission auto-allow threshold toggle to settings"
```

---

### Task 6: Real notifications for permission/flag lifecycle events

**Files:**
- Modify: `src/state/reducer.ts:294-325` (`SET_PENDING_PERMISSION_REQUEST`, `SET_PENDING_POST_TOOL_FLAG`)
- Test: `src/state/reducer.test.ts`

**Interfaces:**
- Consumes: `nowShort` (already imported in `reducer.ts`).
- Produces: no new exports — internal reducer behavior change only.

- [ ] **Step 1: Write the failing tests**

Add to `src/state/reducer.test.ts`:

```typescript
describe('reducer — real notifications for permission/flag lifecycle', () => {
  it('SET_PENDING_PERMISSION_REQUEST pushes a notif when a request newly arrives', () => {
    const request = { requestId: 'r1', toolName: 'Write', toolInput: {}, risk: 'MED' as const, editableField: null };
    const next = reducer(initialState, { type: 'SET_PENDING_PERMISSION_REQUEST', request });
    expect(next.notifs[0].m).toContain('Write');
    expect(next.unread).toBe(initialState.unread + 1);
  });

  it('SET_PENDING_PERMISSION_REQUEST pushes a notif when a request clears (null)', () => {
    const request = { requestId: 'r1', toolName: 'Write', toolInput: {}, risk: 'MED' as const, editableField: null };
    const withPending = { ...initialState, pendingPermissionRequest: request };
    const next = reducer(withPending, { type: 'SET_PENDING_PERMISSION_REQUEST', request: null });
    expect(next.notifs[0].m.toLowerCase()).toContain('resolved');
  });

  it('SET_PENDING_POST_TOOL_FLAG pushes a notif when a flag newly arrives', () => {
    const request = { requestId: 'f1', toolUseId: 't1', toolName: 'Bash', anomalyKind: 'stalledPermission' as const, detail: 'ran 90s' };
    const next = reducer(initialState, { type: 'SET_PENDING_POST_TOOL_FLAG', request });
    expect(next.notifs[0].m).toContain('Bash');
    expect(next.unread).toBe(initialState.unread + 1);
  });
});
```

(`'stalledPermission'` confirmed as a real `Anomaly['kind']` value in `src/shared/anomalyDetectors.ts` — no substitution needed.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/state/reducer.test.ts -t "real notifications"`
Expected: FAIL — `next.notifs[0]` undefined or doesn't match

- [ ] **Step 3: Implement the notif pushes**

In `src/state/reducer.ts`, modify the `SET_PENDING_PERMISSION_REQUEST` case (`reducer.ts:294-308`):

```typescript
    case 'SET_PENDING_PERMISSION_REQUEST': {
      const eventState = { ...state, pendingPermissionRequest: action.request };
      let narrationMessages = state.narrationMessages;
      let narrationBudgets = state.narrationBudgets;
      let notifs = state.notifs;
      let unread = state.unread;
      if (action.request && !state.pendingPermissionRequest) {
        const applied = applyNarrationEvent({ kind: 'permissionPending' }, eventState, narrationMessages, narrationBudgets);
        narrationMessages = applied.narrationMessages;
        narrationBudgets = applied.narrationBudgets;
        notifs = [{ t: nowShort(), m: `Permission requested: ${action.request.toolName} (${action.request.risk})`, c: '#f5c66b' }, ...notifs].slice(0, 12);
        unread += 1;
      } else if (!action.request && state.pendingPermissionRequest) {
        const applied = applyNarrationEvent({ kind: 'stewardStateCheck' }, eventState, narrationMessages, narrationBudgets);
        narrationMessages = applied.narrationMessages;
        narrationBudgets = applied.narrationBudgets;
        notifs = [{ t: nowShort(), m: `Permission request resolved: ${state.pendingPermissionRequest.toolName}`, c: '#3be0a0' }, ...notifs].slice(0, 12);
        unread += 1;
      }
      return { ...state, pendingPermissionRequest: action.request, narrationMessages, narrationBudgets, notifs, unread };
    }
```

And `SET_PENDING_POST_TOOL_FLAG` (`reducer.ts:310-325`):

```typescript
    case 'SET_PENDING_POST_TOOL_FLAG': {
      let narrationMessages = state.narrationMessages;
      let narrationBudgets = state.narrationBudgets;
      let notifs = state.notifs;
      let unread = state.unread;
      if (action.request && !state.pendingPostToolFlag) {
        const eventState = { ...state, pendingPostToolFlag: action.request };
        const applied = applyNarrationEvent(
          { kind: 'postToolFlag', anomalyKind: action.request.anomalyKind },
          eventState,
          narrationMessages,
          narrationBudgets
        );
        narrationMessages = applied.narrationMessages;
        narrationBudgets = applied.narrationBudgets;
        notifs = [{ t: nowShort(), m: `Flagged for review: ${action.request.toolName} (${action.request.anomalyKind})`, c: '#f5c66b' }, ...notifs].slice(0, 12);
        unread += 1;
      } else if (!action.request && state.pendingPostToolFlag) {
        notifs = [{ t: nowShort(), m: `Flag review resolved: ${state.pendingPostToolFlag.toolName}`, c: '#3be0a0' }, ...notifs].slice(0, 12);
        unread += 1;
      }
      return { ...state, pendingPostToolFlag: action.request, narrationMessages, narrationBudgets, notifs, unread };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/state/reducer.test.ts -t "real notifications"`
Expected: PASS

- [ ] **Step 5: Run the full reducer test suite to confirm no regression**

Run: `npx vitest run src/state/reducer.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/state/reducer.ts src/state/reducer.test.ts
git commit -m "feat: push real notifications for permission/flag request lifecycle"
```

---

### Task 7: Real notifications for anomalies and completed dispatches

**Files:**
- Modify: `src/state/reducer.ts:254-277` (`SET_ANOMALIES`), `:414-430` (`RECORD_DISPATCH_USAGE`)
- Test: `src/state/reducer.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/state/reducer.test.ts`:

```typescript
describe('reducer — real notifications for anomalies and completed dispatches', () => {
  it('SET_ANOMALIES pushes a notif for each newly-appeared anomaly', () => {
    const anomaly = { toolUseId: 't1', kind: 'stalledPermission' as const, detail: 'ran 90s' };
    const next = reducer(initialState, { type: 'SET_ANOMALIES', anomalies: [anomaly] });
    expect(next.notifs[0].m).toContain('stalledPermission');
    expect(next.unread).toBe(initialState.unread + 1);
  });

  it('SET_ANOMALIES does not re-notify for an anomaly already present', () => {
    const anomaly = { toolUseId: 't1', kind: 'stalledPermission' as const, detail: 'ran 90s' };
    const withAnomaly = { ...initialState, anomalies: [anomaly] };
    const next = reducer(withAnomaly, { type: 'SET_ANOMALIES', anomalies: [anomaly] });
    expect(next.unread).toBe(withAnomaly.unread);
  });

  it('RECORD_DISPATCH_USAGE pushes a notif reusing the same summary logs already builds', () => {
    const completed = [{ toolUseId: 't1', subagentType: 'general-purpose', description: 'test dispatch', startedAt: new Date(0).toISOString(), prompt: 'do the thing', model: 'claude-sonnet-5', tokens: 5000, toolUses: 3, durationMs: 12000 }];
    const next = reducer(initialState, { type: 'RECORD_DISPATCH_USAGE', completed });
    expect(next.notifs[0].m).toBe(next.logs[next.logs.length - 1].m);
    expect(next.unread).toBe(initialState.unread + 1);
  });
});
```

(Field shapes confirmed against `src/shared/anomalyDetectors.ts` and `src/state/liveAgentsMath.ts` — `CompletedDispatchUsage` extends `RealAgentDispatch`, so it needs `description`/`startedAt`/`prompt`/`model` in addition to the usage fields, included above.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/state/reducer.test.ts -t "anomalies and completed dispatches"`
Expected: FAIL

- [ ] **Step 3: Implement the notif pushes**

In `src/state/reducer.ts`, modify `SET_ANOMALIES` (`reducer.ts:254-277`) — add `notifs`/`unread` threading alongside the existing `newAnomalies` loop:

```typescript
    case 'SET_ANOMALIES': {
      const prevIds = new Set(state.anomalies.map((a) => `${a.toolUseId}:${a.kind}`));
      const newAnomalies = action.anomalies.filter((a) => !prevIds.has(`${a.toolUseId}:${a.kind}`));
      const eventState = { ...state, anomalies: action.anomalies };
      let narrationMessages = state.narrationMessages;
      let narrationBudgets = state.narrationBudgets;
      let notifs = state.notifs;
      let unread = state.unread;
      for (const anomaly of newAnomalies) {
        const applied = applyNarrationEvent(
          { kind: 'anomalyDetected', toolUseId: anomaly.toolUseId, anomalyKind: anomaly.kind },
          eventState,
          narrationMessages,
          narrationBudgets
        );
        narrationMessages = applied.narrationMessages;
        narrationBudgets = applied.narrationBudgets;
        notifs = [{ t: nowShort(), m: `Anomaly detected: ${anomaly.kind} — ${anomaly.detail}`, c: '#ff9d9d' }, ...notifs].slice(0, 12);
        unread += 1;
      }
      const cleared = applyNarrationEvent({ kind: 'stewardStateCheck' }, eventState, narrationMessages, narrationBudgets);
      narrationMessages = cleared.narrationMessages;
      narrationBudgets = cleared.narrationBudgets;
      return { ...state, anomalies: action.anomalies, narrationMessages, narrationBudgets, notifs, unread };
    }
```

Modify `RECORD_DISPATCH_USAGE` (`reducer.ts:414-430`) — reuse the same message string `logs` already builds:

```typescript
    case 'RECORD_DISPATCH_USAGE': {
      let dispatchUsage = state.dispatchUsage;
      let logs = state.logs;
      let notifs = state.notifs;
      let unread = state.unread;
      for (const c of action.completed) {
        dispatchUsage = { ...dispatchUsage, [c.toolUseId]: { tokens: c.tokens, toolUses: c.toolUses, durationMs: c.durationMs } };
        const summary = `${c.subagentType}: ${short(c.tokens)} tok · ${c.toolUses} tool call${c.toolUses === 1 ? '' : 's'} · ${fmtElapsed(c.durationMs)}`;
        logs = logs.concat({ t: nowLong(), m: summary, c: '#3be0a0' }).slice(-14);
        notifs = [{ t: nowShort(), m: summary, c: '#3be0a0' }, ...notifs].slice(0, 12);
        unread += 1;
      }
      const keys = Object.keys(dispatchUsage);
      if (keys.length > 100) {
        const toEvict = new Set(keys.slice(0, keys.length - 100));
        dispatchUsage = Object.fromEntries(Object.entries(dispatchUsage).filter(([k]) => !toEvict.has(k)));
      }
      return { ...state, dispatchUsage, logs, notifs, unread };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/state/reducer.test.ts -t "anomalies and completed dispatches"`
Expected: PASS

- [ ] **Step 5: Run the full reducer test suite**

Run: `npx vitest run src/state/reducer.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/state/reducer.ts src/state/reducer.test.ts
git commit -m "feat: push real notifications for anomalies and completed dispatches"
```

---

### Task 8: Real notification for the hook's own notification reason

**Files:**
- Modify: `src/state/reducer.ts:339-340` (`SET_LAST_NOTIFICATION`)
- Test: `src/state/reducer.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/state/reducer.test.ts`:

```typescript
describe('reducer — real notification for hook notification reason', () => {
  it('SET_LAST_NOTIFICATION pushes a notif in addition to setting lastNotification', () => {
    const next = reducer(initialState, { type: 'SET_LAST_NOTIFICATION', reason: 'permission_prompt' });
    expect(next.lastNotification?.reason).toBe('permission_prompt');
    expect(next.notifs[0].m).toContain('permission_prompt');
    expect(next.unread).toBe(initialState.unread + 1);
  });
});
```

(`'permission_prompt'` confirmed as a real named `NotificationReason` value in `src/shared/alertSounds.ts` — no substitution needed.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/state/reducer.test.ts -t "hook notification reason"`
Expected: FAIL

- [ ] **Step 3: Implement**

In `src/state/reducer.ts`, replace the `SET_LAST_NOTIFICATION` case (`reducer.ts:339-340`):

```typescript
    case 'SET_LAST_NOTIFICATION':
      return {
        ...state,
        lastNotification: { reason: action.reason, atMs: Date.now() },
        notifs: [{ t: nowShort(), m: `Notification: ${action.reason}`, c: '#7fd8ef' }, ...state.notifs].slice(0, 12),
        unread: state.unread + 1,
      };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/state/reducer.test.ts -t "hook notification reason"`
Expected: PASS

- [ ] **Step 5: Run the full reducer test suite**

Run: `npx vitest run src/state/reducer.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/state/reducer.ts src/state/reducer.test.ts
git commit -m "feat: push real notification for hook notification reason"
```

---

### Task 9: Remove `tick.ts`'s fictional approval/notification generator

**Files:**
- Modify: `src/state/tick.ts:1-11,53-67` (`APPROVAL_POOL` and its spawn block)
- Test: `src/state/tick.test.ts`

- [ ] **Step 1: Update the failing/changed tests first**

In `src/state/tick.test.ts`, remove the test at line 97 (`'never grows the approvals queue past 3 pending requests'`) and its fixture at line 101, and update the assertion at line 35 (`expect(result.approvals).toEqual(state.approvals)`) — once `computeTick` no longer touches `approvals` at all, this line either becomes obsolete (delete it) or trivially true; delete it along with any other line in this file referencing `.approvals`.

Run: `npx vitest run src/state/tick.test.ts`
Expected: some failures — file still has references to removed behavior at this point; fix them per Step 1 above until only currently-real assertions remain (rate-limit alarm notif test, sys metrics, weekRaw, etc. all stay).

- [ ] **Step 2: Remove `APPROVAL_POOL` and the spawn block**

In `src/state/tick.ts`, delete the `APPROVAL_POOL` constant (`tick.ts:4-11`) and the entire `let approvals = state.approvals; ... }` block (`tick.ts:53-67`). The function's final `return` statement (`tick.ts:69`) drops `approvals, apprSeq` from its returned object:

```typescript
  return { used, weekRaw, agents, sys, alarmLevel: level, notifs, unread };
```

- [ ] **Step 3: Run the full tick test suite**

Run: `npx vitest run src/state/tick.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/state/tick.ts src/state/tick.test.ts
git commit -m "feat: remove fictional APPROVAL_POOL generator from tick.ts"
```

---

### Task 10: Remove `Approval`/`state.approvals`/`apprSeq` from state model

**Files:**
- Modify: `src/state/types.ts:31-68,257-258` (delete `Approval` interface + its comment, `approvals`/`apprSeq` fields)
- Modify: `src/state/initialState.ts:22-42` (delete seeded `approvals`/`apprSeq`)
- Modify: `src/state/reducer.ts` (delete `ADD_APPROVAL`/`RESOLVE_APPROVAL` action types + cases, `applyApprovalResolution` helper, `chatApproval`-adjacent imports if any become unused)
- Modify: `src/state/persistence.ts:74-75` (remove from `savePersisted` slice)
- Test: `src/state/reducer.test.ts`, `src/state/persistence.test.ts`

**Interfaces:**
- Removes: `Approval` type, `AetherState.approvals`, `AetherState.apprSeq`, `ADD_APPROVAL`/`RESOLVE_APPROVAL` actions. Task 12 (`commands.ts`) depends on this task being complete first, since it needs `state.approvals` gone before its own rewrite makes sense — but do this task first, then Task 12, so intermediate commits don't leave `commands.ts` referencing a deleted field for more than one task's commit boundary. If Vitest fails on `commands.ts`/`commands.test.ts` after this task's own test files pass, that failure is expected and resolved by Task 12 — do not fix it here.

- [ ] **Step 1: Remove the tests that exercise deleted behavior**

In `src/state/reducer.test.ts`, delete every test in the ranges described by the spec addendum: the `RESOLVE_APPROVAL`/`ADD_APPROVAL` describe blocks and individual `it`s at (approximately) lines 47-70, 586-683, plus the `chatApproval` helper function they use if it has no other callers after these deletions.

In `src/state/persistence.test.ts`, remove `approvals`/`apprSeq` from the `distinctiveState` fixture (around line 128-129) and their corresponding assertions (around line 170-171).

- [ ] **Step 2: Run reducer/persistence tests to confirm the deletions themselves are clean**

Run: `npx vitest run src/state/reducer.test.ts src/state/persistence.test.ts`
Expected: FAIL — `state.approvals`/`apprSeq` still exist in types/initialState at this point, so the deleted tests' absence alone doesn't yet break anything; this step is a checkpoint that the test files are syntactically valid, not a red-green gate. If it passes already, continue.

- [ ] **Step 3: Delete `Approval` and the two fields from `types.ts`**

In `src/state/types.ts`, delete the `Approval` interface and its entire preceding comment block (`types.ts:31-68`), and delete `approvals: Approval[];` and `apprSeq: number;` from `AetherState` (`types.ts:257-258`). Also remove the now-unused `Approval` from `reducer.ts`'s import line (`reducer.ts:1`).

- [ ] **Step 4: Delete `ADD_APPROVAL`/`RESOLVE_APPROVAL` from the `Action` union and their cases in `reducer.ts`**

Delete from the `Action` type union (`reducer.ts:21-22`):
```typescript
  | { type: 'RESOLVE_APPROVAL'; id: number; approve: boolean }
  | { type: 'ADD_APPROVAL'; approval: Omit<Approval, 'id'>; autoResolve?: boolean }
```

Delete the `applyApprovalResolution` function entirely (`reducer.ts:87-140`), and the `THROTTLE_SHARE_CEILING` constant if it's not used elsewhere (check first: `grep -n THROTTLE_SHARE_CEILING src/state/reducer.ts`).

Delete the `ADD_APPROVAL` case (`reducer.ts:435-451`) and `RESOLVE_APPROVAL` case (`reducer.ts:453-457`).

- [ ] **Step 5: Delete seeded approvals from `initialState.ts`**

Delete the `approvals: [...]` array (`initialState.ts:22-41`) and `apprSeq: 3,` (`initialState.ts:42`) from `initialState.ts`.

- [ ] **Step 6: Remove from `persistence.ts`'s saved slice**

Delete `approvals: state.approvals,` and `apprSeq: state.apprSeq,` from the `slice` object in `savePersisted` (`persistence.ts:74-75`).

- [ ] **Step 7: Run the reducer/persistence/types-consuming test suites**

Run: `npx vitest run src/state/reducer.test.ts src/state/persistence.test.ts`
Expected: PASS

Note: `npx vitest run` across the whole repo will still fail at this point (`tick.test.ts` already fixed in Task 9, but `commands.ts`/`commands.test.ts`/`TopBar.tsx`/`SystemsCard.tsx` still reference the now-deleted `state.approvals` — that's expected and resolved by Tasks 11-13). Do not attempt to fix those files in this task.

- [ ] **Step 8: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/reducer.ts src/state/persistence.ts src/state/reducer.test.ts src/state/persistence.test.ts
git commit -m "feat: remove fictional Approval type and state.approvals/apprSeq"
```

---

### Task 11: Migrate Terminal's `approvals`/`approve`/`deny` commands to real pending requests

**Files:**
- Modify: `src/components/terminal/commands.ts:195-221`
- Test: `src/components/terminal/commands.test.ts`

**Interfaces:**
- Consumes: `state.pendingPermissionRequest`, `state.pendingPostToolFlag` (real state, unchanged shape).
- Produces: `runCommand` remains `(state: AetherState, raw: string) => CommandResult`, but for `approve`/`deny` it now also calls `window.aetherElectron.permission.respond`/`window.aetherElectron.postToolFlag.respond` as a side effect — the one deliberate exception to this file's purity, per the plan's Global Constraints.

- [ ] **Step 1: Write the failing tests**

Replace the tests at `commands.test.ts:67-81` (the `approve`/`deny` describe block) with:

```typescript
import { vi } from 'vitest';

describe('approvals/approve/deny against real pending requests', () => {
  const permissionRequest = { requestId: 'r1', toolName: 'Write', toolInput: { file_path: 'x.ts' }, risk: 'MED' as const, editableField: null };
  const flagRequest = { requestId: 'f1', toolUseId: 't1', toolName: 'Bash', anomalyKind: 'stalledPermission' as const, detail: 'ran 90s' };

  it('approvals lists both real pending requests when present', () => {
    const state = { ...initialState, pendingPermissionRequest: permissionRequest, pendingPostToolFlag: flagRequest };
    const result = runCommand(state, 'approvals');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.lines.some((l) => l.t.includes('Write'))).toBe(true);
    expect(result.lines.some((l) => l.t.includes('Bash'))).toBe(true);
  });

  it('approvals reports queue clear when nothing is pending', () => {
    const result = runCommand(initialState, 'approvals');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.lines.some((l) => l.t.includes('queue clear'))).toBe(true);
  });

  it('approve 1 resolves the real permission request via IPC when it is first in the list', () => {
    const respond = vi.fn();
    (window as any).aetherElectron = { permission: { respond }, postToolFlag: { respond: vi.fn() } };
    const state = { ...initialState, pendingPermissionRequest: permissionRequest };
    const result = runCommand(state, 'approve 1');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(respond).toHaveBeenCalledWith('r1', { behavior: 'allow', updatedInput: permissionRequest.toolInput });
  });

  it('deny 1 resolves the real permission request as denied via IPC', () => {
    const respond = vi.fn();
    (window as any).aetherElectron = { permission: { respond }, postToolFlag: { respond: vi.fn() } };
    const state = { ...initialState, pendingPermissionRequest: permissionRequest };
    const result = runCommand(state, 'deny 1');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(respond).toHaveBeenCalledWith('r1', { behavior: 'deny', reason: 'denied via Terminal' });
  });

  it('approve on an out-of-range index reports an error and calls no IPC', () => {
    const respond = vi.fn();
    (window as any).aetherElectron = { permission: { respond }, postToolFlag: { respond: vi.fn() } };
    const result = runCommand(initialState, 'approve 1');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.lines.some((l) => l.t.includes('no request'))).toBe(true);
    expect(respond).not.toHaveBeenCalled();
  });
});
```

Delete the old `approve on a HIGH risk request raises the rate by 9000...` test (`commands.test.ts:67-77`) and the old out-of-range test (`commands.test.ts:80-81`) if their bodies still reference `state.approvals` — replaced by the block above.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/terminal/commands.test.ts`
Expected: FAIL — `commands.ts` still reads `state.approvals`, which no longer exists on `AetherState` (TypeScript compile error) or the old runtime behavior doesn't match

- [ ] **Step 3: Rewrite the `approvals`/`approve`/`deny` cases**

In `src/components/terminal/commands.ts`, replace the `approvals` case (`commands.ts:195-201`) and `approve`/`deny` case (`commands.ts:203-221`):

```typescript
    case 'approvals': {
      const pending = [
        state.pendingPermissionRequest && { kind: 'permission' as const, req: state.pendingPermissionRequest },
        state.pendingPostToolFlag && { kind: 'flag' as const, req: state.pendingPostToolFlag },
      ].filter((x): x is { kind: 'permission' | 'flag'; req: NonNullable<typeof x>['req'] } => Boolean(x));
      if (!pending.length) out.push(line('  queue clear', DIM));
      pending.forEach((p, i) =>
        out.push(line(`  [${i + 1}] ${p.req.risk ?? 'REVIEW'.padEnd(5)}${p.req.toolName} — ${p.kind === 'permission' ? 'permission request' : 'post-tool flag'}`, p.req.risk === 'HIGH' ? BAD : '#f5c66b')),
      );
      return { kind: 'append', lines: out };
    }

    case 'approve':
    case 'deny': {
      const n = parseInt(args[0], 10);
      const pending = [
        state.pendingPermissionRequest && { kind: 'permission' as const, req: state.pendingPermissionRequest },
        state.pendingPostToolFlag && { kind: 'flag' as const, req: state.pendingPostToolFlag },
      ].filter((x): x is { kind: 'permission' | 'flag'; req: any } => Boolean(x));
      const target = pending[n - 1];
      const approve = cmd.toLowerCase() === 'approve';
      if (!target) {
        out.push(line(`✗ no request [${args[0]}] — run 'approvals'`, BAD));
        return { kind: 'append', lines: out };
      }
      out.push(line(`✓ ${approve ? 'approved' : 'denied'}: ${target.req.toolName}`, approve ? GOOD : BAD));
      if (target.kind === 'permission') {
        window.aetherElectron?.permission.respond(
          target.req.requestId,
          approve ? { behavior: 'allow', updatedInput: target.req.toolInput } : { behavior: 'deny', reason: 'denied via Terminal' }
        );
      } else {
        window.aetherElectron?.postToolFlag.respond(
          target.req.requestId,
          approve ? { block: false } : { block: true, reason: 'denied via Terminal' }
        );
      }
      return { kind: 'append', lines: out };
    }
```

Note the `risk ?? 'REVIEW'` handling in the `approvals` listing: `PostToolFlagRequestUI` has no `risk` field (only `PermissionRequestUI` does) — confirm this against `types.ts`'s two interfaces before finalizing and adjust the display line if the padding/fallback needs cleanup once you see it rendered.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/terminal/commands.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/terminal/commands.ts src/components/terminal/commands.test.ts
git commit -m "feat: migrate Terminal approvals/approve/deny commands to real pending requests"
```

---

### Task 12: Point `TopBar.tsx`'s approval badge/dropdown at real pending requests

**Files:**
- Modify: `src/components/layout/TopBar.tsx:30-112`
- Test: `src/components/layout/TopBar.test.tsx` (check if it already exists first)

- [ ] **Step 1: Check for an existing test file**

Run: `ls src/components/layout/TopBar.test.tsx 2>/dev/null || echo "no existing test file"`

- [ ] **Step 2: Replace the approvals section**

In `src/components/layout/TopBar.tsx`, replace `const pendingCount = state.approvals.length;` (line 33) with:

```typescript
  const pendingReal = [
    state.pendingPermissionRequest && { kind: 'permission' as const, req: state.pendingPermissionRequest },
    state.pendingPostToolFlag && { kind: 'flag' as const, req: state.pendingPostToolFlag },
  ].filter((x): x is { kind: 'permission' | 'flag'; req: any } => Boolean(x));
  const pendingCount = pendingReal.length;
```

Replace the dropdown body (`TopBar.tsx:86-111`, the `state.apprOpen && (...)` block's inner `state.approvals.map(...)`):

```tsx
        {state.apprOpen && (
          <div style={apprPanelStyle(colors)}>
            <div style={panelTitleStyle(colors)}>⛉ APPROVAL QUEUE — real pending requests</div>
            {pendingReal.map((p) => (
              <div key={p.req.requestId} style={apprRowStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={apprActionStyle(colors)}>{p.req.toolName}</span>
                  {p.kind === 'permission' && <span style={riskBadgeStyle(colors, p.req.risk)}>{p.req.risk}</span>}
                </div>
                <div style={apprDetailStyle(colors)}>
                  {p.kind === 'permission' ? 'Permission request' : `Flagged: ${p.req.anomalyKind}`}
                </div>
                <div style={{ display: 'flex', gap: 7 }}>
                  <Button
                    onClick={() =>
                      p.kind === 'permission'
                        ? window.aetherElectron?.permission.respond(p.req.requestId, { behavior: 'allow', updatedInput: p.req.toolInput })
                        : window.aetherElectron?.postToolFlag.respond(p.req.requestId, { block: false })
                    }
                    style={approveBtnStyle(colors)}
                  >
                    APPROVE
                  </Button>
                  <Button
                    onClick={() =>
                      p.kind === 'permission'
                        ? window.aetherElectron?.permission.respond(p.req.requestId, { behavior: 'deny', reason: 'denied via approvals queue' })
                        : window.aetherElectron?.postToolFlag.respond(p.req.requestId, { block: true, reason: 'denied via approvals queue' })
                    }
                    style={denyBtnStyle(colors)}
                  >
                    DENY
                  </Button>
                </div>
              </div>
            ))}
            {!pendingReal.length && <div style={emptyStateStyle(colors)}>queue clear — no requests awaiting authorization</div>}
          </div>
        )}
```

- [ ] **Step 3: Run existing layout tests to confirm no regression**

Run: `npx vitest run src/components/layout`
Expected: PASS (no existing test currently pins `TopBar.tsx`'s approvals-specific markup — if one does, update its assertions to match the new real-state source instead of `state.approvals`)

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/TopBar.tsx
git commit -m "feat: point TopBar approval badge/dropdown at real pending permission/flag requests"
```

---

### Task 13: Point `SystemsCard.tsx`'s tile at real pending requests

**Files:**
- Modify: `src/components/dashboard/SystemsCard.tsx:17`
- Test: `src/components/dashboard/SystemsCard.test.tsx` (check if it already exists first)

- [ ] **Step 1: Check for an existing test file**

Run: `ls src/components/dashboard/SystemsCard.test.tsx 2>/dev/null || echo "no existing test file"`

- [ ] **Step 2: Replace the row source**

In `src/components/dashboard/SystemsCard.tsx`, replace line 17:

```typescript
    { k: 'Pending approvals', v: String(state.approvals.length), c: state.approvals.length ? colors.warn : colors.success },
```

with:

```typescript
    (() => {
      const count = (state.pendingPermissionRequest ? 1 : 0) + (state.pendingPostToolFlag ? 1 : 0);
      return { k: 'Pending approvals', v: String(count), c: count ? colors.warn : colors.success };
    })(),
```

(If the surrounding `rows` array's element type doesn't accept an IIFE cleanly, restructure as a `const pendingApprovalsRow = ...; const rows = [..., pendingApprovalsRow, ...];` above the array instead — whichever reads cleaner once you see the full file; both are equivalent.)

- [ ] **Step 3: Run existing dashboard tests to confirm no regression**

Run: `npx vitest run src/components/dashboard`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/SystemsCard.tsx
git commit -m "feat: point SystemsCard pending-approvals tile at real pending requests"
```

---

### Task 14: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `npx vitest run`
Expected: PASS, 0 failures

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (this is the real check that every `state.approvals`/`Approval` reference was actually removed — a missed reference anywhere in the codebase, including a file not touched by this plan, surfaces here)

- [ ] **Step 3: Build**

Run: `npm run build` (or this repo's equivalent — check `package.json`'s `scripts` first if the command name differs)
Expected: clean build, no errors

- [ ] **Step 4: Manual smoke test**

Launch the app (`npm run dev` or equivalent). Confirm:
- The TopBar approvals badge shows 0 and never spontaneously spawns an entry.
- The notification bell is empty on a fresh launch and only gains entries from real activity (a real tool call, a real anomaly, etc.) — not from a timer.
- Settings → Operating Mode shows the new PERMISSION AUTO-ALLOW toggle, defaulted to LOW+MED.
- If reachable (an active Claude Code session using this permission server), a Read/Edit call auto-allows silently; a destructive Bash call (e.g. containing `rm`) still prompts via `PermissionRequestCard`.

- [ ] **Step 5: No commit for this task** (verification-only; if Steps 1-3 surface issues, fix them as amendments to the specific task that introduced them, each with its own commit, rather than one large fixup commit here)
