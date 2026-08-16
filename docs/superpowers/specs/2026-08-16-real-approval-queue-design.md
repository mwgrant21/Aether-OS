# Real approval queue & notifications (replace simulated cockpit data)

## Problem

`TopBar.tsx`'s "Pending approvals" badge and notification bell are both driven
by `src/state/tick.ts`'s `APPROVAL_POOL` — a hardcoded array of 6 fictional
actions (e.g. `Call external pricing API`) that gets randomly spawned into
`state.approvals` / `state.notifs` on every 900ms tick (`store.tsx:27`),
independent of anything actually happening in the app. Because 2 of the 6
pool entries are `risk: 'HIGH'` and HIGH-risk entries are never
auto-approved, clearing one just means another (often the same one) reappears
within ~10-30s.

Meanwhile aether-os already has a **real** permission pipeline that these two
surfaces ignore entirely:
- `electron/permissionServer.ts` + `main.ts`'s `onPermissionRequest` — receives
  real Claude Code tool-permission requests over HTTP, classifies risk via
  `classifyPermissionRisk` (`src/shared/permissionRisk.ts`), and *always*
  blocks on a renderer round-trip (`permission:request` / `permission:respond`)
  regardless of risk. Surfaced today only via `PermissionRequestCard.tsx` +
  `state.pendingPermissionRequest`.
- `main.ts`'s `onPostToolUse` — anomaly-triggered post-tool review, same
  resolver pattern, surfaced via `state.pendingPostToolFlag`.
- Real event streams already flowing into state but not surfaced as
  notifications: `SET_ANOMALIES`, `RECORD_DISPATCH_USAGE`, `SET_CACHE_HIT_RATIO`,
  the hook's own `onNotification` reason (`SET_LAST_NOTIFICATION`), and
  `state.logs` (dispatch completion / channel-open entries, already rendered
  in `LiveOutputCard.tsx` / `LogFrequencyCard.tsx`).

## Goals

1. Delete the fictional data generator; TopBar's approvals badge and
   notification bell reflect only real events.
2. Real permission requests below a configurable risk threshold auto-allow
   with zero prompt; only requests at/above the threshold surface for manual
   approval.
3. TopBar's "Pending approvals" becomes a thin view over the same real
   `pendingPermissionRequest` / `pendingPostToolFlag` state `PermissionRequestCard`
   already uses — not a new parallel queue.
4. TopBar's notification bell becomes a real, capped event log fed by actual
   anomaly / dispatch / permission / cache-hit-ratio events, plus the
   already-real rate-limit alarm (computed from real statusline pressure).

## Non-goals

- Not touching `PermissionRequestCard.tsx`'s existing allow/deny UI or the
  `permission:respond` IPC contract — reused as-is.
- Not changing how `state.logs` (Terminal/analytics log) is populated.
- Not building a history/audit view of past approvals — out of scope.

## Design

### 1. Auto-allow threshold (new setting)

Add `cfg.permissionAutoAllow: 'NONE' | 'LOW' | 'LOW_MED'` to `AetherState['cfg']`
(`types.ts`, `initialState.ts`), default `'LOW_MED'`, following the existing
`cfg.opMode` / `cfg.autoThrottle` convention. Exposed as a new control in
`settings/OperatingModeCard.tsx` (or a sibling card next to it — implementer's
call), same style as the existing operating-mode toggle.

`main.ts`'s `onPermissionRequest` classifies risk (as it already does via
`classifyPermissionRisk`) *before* touching the renderer:
- If the request's risk is at/below the configured threshold, resolve
  `{ behavior: 'allow' }` immediately — no `sendToWindow('permission:request', ...)`,
  no renderer round-trip, no `pendingPermissionResolvers` entry.
- Otherwise, proceed exactly as today (prompt via `PermissionRequestCard`).

The threshold value needs to reach `main.ts` from renderer-owned `cfg` state.
Confirmed: no main↔renderer settings channel exists today (`cfg`, including
`opMode`/`autoThrottle`, is renderer-only — persisted via `persistence.ts` in
the renderer, never read by `main.ts`). This task needs a small new IPC pair
(e.g. `settings:permissionAutoAllow` pushed from renderer to main on change,
mirroring the `sendToWindow`/`ipcMain.handle` pattern `permission:respond`
already uses) so `onPermissionRequest` can read the current threshold.

`onPostToolUse` (anomaly-triggered flag review) is unaffected — it already
only prompts when an anomaly detector actually trips, which is inherently a
"this needs a human" signal, not a routine-risk one.

### 2. TopBar's "Pending approvals" → real pending requests

Remove `state.approvals` / `state.apprSeq` and the `APPROVAL_POOL` spawn
block in `tick.ts` entirely. `TopBar.tsx`'s pending-approvals badge count and
dropdown become a direct read of:
- `state.pendingPermissionRequest` (0 or 1)
- `state.pendingPostToolFlag` (0 or 1)

Allow/deny actions in the dropdown dispatch the same real decision path
`PermissionRequestCard.tsx` already uses (`aetherElectron.permissions.respond`
/ equivalent for post-tool-flag) — no new IPC surface, just a second place
that can trigger the existing one. `PermissionRequestCard` itself is
unchanged; both surfaces read the same state, so they stay in sync.

### 3. TopBar's notification bell → real event log

Remove the `APPROVAL_POOL`-driven "requests approval:" / "Auto-approved:"
synthetic notif entries from `tick.ts`. Keep the rate-limit-alarm notif block
(`tick.ts:41-51`) as-is — it's already computed from real `state.statusline`
pressure data, just currently interleaved with fake filler.

Add real notif entries (same `{ t, m, c }` shape as today, pushed through the
existing `notifs`/`unread` reducer pattern) on:
- Permission request created / auto-allowed / resolved (mirrors what
  `pendingPermissionRequest` transitions already trigger for narration —
  `reducer.ts:294-308` — add a notif push alongside the existing
  `applyNarrationEvent` calls there).
- Post-tool-flag created / resolved (same, alongside `reducer.ts:310-325`).
- `SET_ANOMALIES` transitions (new anomaly appearing).
- `RECORD_DISPATCH_USAGE` (dispatch completed) — reuse the same summary
  string `logs` already builds (`reducer.ts:417-419`) rather than inventing
  new copy.
- The hook's own `SET_LAST_NOTIFICATION` reason.

`RecentAlertsCard.tsx` needs no changes — it already just renders
`state.notifs.slice(0, 8)`.

## Testing

- `tick.test.ts`: remove/replace tests asserting `APPROVAL_POOL` spawn
  behavior; keep the rate-limit-alarm notif test.
- `reducer.test.ts`: new notif-push assertions for each event above; existing
  `pendingPermissionRequest`/`pendingPostToolFlag` narration tests must still
  pass unchanged.
- `main.ts` permission-server tests (`permissionServer.test.ts`,
  `notificationHandler.test.ts`): new case for the auto-allow threshold —
  LOW/MED request resolves `{ behavior: 'allow' }` synchronously with no
  `sendToWindow` call when threshold permits; HIGH always prompts regardless
  of threshold.
- Manual: run the app, confirm the approvals badge stays at 0 with no fake
  entries, and a real Read/Edit tool call from an active Claude Code session
  auto-allows silently while a destructive Bash call still prompts.

## Risks

- The auto-allow threshold is a real trust-boundary change: at the default
  (`LOW_MED`), aether-os will now allow Write/Edit and most Bash calls
  without a human in the loop. This is the explicit behavior requested, but
  it should ship with the setting clearly visible/editable, not buried.
- `cfg` reaching `main.ts` requires new IPC plumbing (confirmed none exists
  today) — sizeable enough to warrant its own plan task rather than a
  drive-by addition inside the auto-allow task.
