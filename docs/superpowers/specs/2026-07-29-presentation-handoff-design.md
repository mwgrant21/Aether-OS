# Presentation & Handoff (Stage 7) — Design

## Origin

`docs/roadmap.md` Stage 7: "The `claude agents` teardown lessons, which had no home in the first
draft of this roadmap — see §3.2." (~8 tasks). §3.2 lists seven design lessons pulled from a
competitive teardown of `claude agents` and other fleet-management tools, covering everything
about how Aether OS presents itself and hands control back to the user when they return to it.

## What this builds on

Stage 6 already ships a local HTTP server in the main process (`electron/permissionServer.ts`)
brokering `PermissionRequest`/`PostToolUse` for Aether's own pinned session, and Stage 5 ships a
real, per-second `liveAgentTracker.tick()` covering dispatches, anomalies, and usage. This stage
adds no new *data source* — it adds a focus-aware consumer of the tick stream, and one new hook
event (`Notification`) riding the same server Stage 6 already built.

Confirmed against the codebase (not inferred): `collector/src/hookPayload.ts` already parses
`notification_type` off real `Notification` hook payloads into the collector's `events` table, but
nothing downstream consumes it — this stage is what finally does. Confirmed there is zero existing
focus-tracking, `setOverlayIcon`/`flashFrame` usage, or roster grouping/glyph logic anywhere in
`electron/main.ts` or `src/components/agents/AgentRosterCard.tsx` — every item below is new, not an
extension of something partially built.

## Scope decisions (resolved during brainstorming)

- **One stage, all seven items** — matches the roadmap's own ~8-task sizing and Stage 5/6
  precedent; not decomposed further.
- **Model-written headlines are in scope**, not deferred — rated the highest-leverage single idea
  in the roadmap's own first-party survey.
- **Recap is in-memory only** — resets on app restart. No new persistence surface, no
  `docs/privacy-and-data.md` consideration beyond what already exists.
- **Notification signal source: extend the existing Stage 6 permission HTTP server**, not the
  collector's ~15s-poll `events` table. A badge/flash/sound reacting 15 seconds late defeats the
  point; the server already gives near-instant, session-scoped delivery for a different hook
  event, and `Notification` rides the same mechanism.
- **Overlay badge is a rendered image, not a raw count.** `BrowserWindow.setOverlayIcon()` takes a
  `NativeImage`, not a number — showing a count means rendering a small canvas (circle + digit)
  into a `NativeImage` each time the count changes, then passing `null` on focus to clear it. Noted
  explicitly so the implementation plan doesn't treat this as a one-line API call.
- **Transcript density control is a single global Settings toggle** (Normal/Verbose/Summary),
  persisted the same way the existing light/dark theme preference is — not a per-view control.
- **Summary density scope**: `AgentDetailCard`'s prompt/output display, roster rows, and Memory's
  auto-captured dispatch-completion entries. Terminal's live `xterm` pty output is explicitly
  excluded at every density level — it's an interactive shell, not a summarizable transcript.

## Architecture

```
Claude Code (Aether's own pinned session only)
  │ Notification hook (stdin JSON: session_id, notification_type)
  ▼
hook script (Node, joins the existing Stage 6 hook group)
  │ session_id check against own-session.json (Stage 4 infra, reused)
  ▼
electron/permissionServer.ts (extended, new onNotification route)
  │ fire-and-forget ack -- no decision to return, unlike Permission/PostToolUse
  ▼
electron/main.ts
  │ isWindowFocused? ──yes──► track internally (badge count stays consistent if focus is lost
  │                            again soon), but suppressed: no sound/flash/visible badge shown
  │        │no
  │        ▼
  │  flashFrame(true) + setOverlayIcon(renderedBadge, description) + typed sound (playNotification: reason)
  │
  │ (independently, every 1s tick while !isWindowFocused)
  │  diff tick(t) vs tick(t-1) ──► RecapAccumulator.accumulate()
  │
  ▼ win.on('focus')
  flashFrame(false), clear overlay icon, package RecapAccumulator,
  IPC `presence:recap` (once), reset accumulator
  ▼
renderer: dismissible recap banner + presence-aware sound/roster/density consumers
```

Model-written headlines and roster/density rendering are renderer-side (or renderer-triggered)
consumers of this same tick stream and are detailed in their own component entries below; they do
not introduce a second data path.

## Components

| File | Purpose |
|---|---|
| `collector/src/hookInstaller.ts` (extend) | `PERMISSION_HOOK_EVENTS` gains `'Notification'`. Same marker-keyed-group mechanism Stage 6 already uses for `PostToolUse` coexistence — no replacement of existing groups. |
| Hook script (new or extends Stage 6's, Node `.mjs`) | Reads stdin, checks `session_id` against `own-session.json`, POSTs `{sessionId, notificationType}` to the permission server; non-blocking ack, no decision contract to honor (unlike `PermissionRequest`/`PostToolUse`). |
| `electron/permissionServer.ts` (extend) | New optional `onNotification?: (req: {sessionId, notificationType}) => void` callback and route, fire-and-forget, wrapped in the same `invokeSafely`-style guard as the existing two routes. |
| `electron/recapAccumulator.ts` (new, pure) | `RecapEntry`/`RecapAccumulator` types; `accumulate(prev, tickResult, prevTickResult): RecapAccumulator` diffing dispatch/anomaly/usage deltas. No Electron API usage — unit-testable like `tick.ts`. |
| `electron/main.ts` (extend) | `isWindowFocused` tracked via `BrowserWindow` `focus`/`blur`; wires the `onNotification` callback to badge/flash/sound-or-suppress; runs `accumulate()` each tick while unfocused; sends `presence:recap` once on `focus`. |
| `src/shared/alertSounds.ts` (extend) | New `AlertAction` variant `{ kind: 'playNotification', reason: 'agent_needs_input' \| 'agent_completed' \| 'permission_prompt' }`; one synthesized tone per reason using existing oscillator primitives — no new audio assets. |
| `electron/headlineGenerator.ts` (new) | `generateHeadline(dispatch, trigger: 'periodic' \| 'blocked')`, reusing the existing `runChatRequest`/`chatCore.ts` pipeline with a Haiku-class model. `Map<toolUseId, lastCallMs>` throttle floors periodic rewrites at 15s; `blocked` trigger (fired by the same Notification event) bypasses the throttle and is scoped to the actual blocking context so the rewritten headline states the question, not a generic "Blocked" label. Failure → silently keep the local-derived default summary, never surfaces an error. |
| `src/components/agents/AgentRosterCard.tsx` (rework) | Groups rows under `NEEDS INPUT` / `WORKING` / `DONE` headers (`NEEDS INPUT` always first); two-axis glyph (colour = state, shape = process liveness, ring = active anomaly) replaces the current two-letter avatar; only `DONE` may collapse into a "+N more" summary — anomalous rows are never scrolled past silently. |
| `src/components/agents/rosterGrouping.ts` (new, pure) | Dispatch + anomaly state → group assignment and collapse-eligibility; unit-tested like `agentsMath.test.ts`. |
| `src/state/types.ts` / Settings (extend) | New `densityLevel: 'normal' \| 'verbose' \| 'summary'` persisted setting, same mechanism as the existing theme toggle; a `useDensity()` hook mirrors `useColors()`. |
| `src/shared/transcriptDensity.ts` (new, pure) | `applyDensity(content, level)`-style transform: `verbose`/`normal` pass content through unchanged, `summary` collapses to the headline (Section 4's model-written headline, or its local-derived default) alone. Consumed by `AgentDetailCard`, roster rows, and Memory's dispatch entries — one shared transform, not three separate collapse implementations. |
| `src/components/dashboard/RecapBanner.tsx` (new) | Renders the `presence:recap` payload as a dismissible, auto-expiring (~10s) banner — not a modal, matching the "leave it open while away" philosophy. |

## Error handling

- Notification hook/server path follows the exact discipline already established for
  `PostToolUse`/`PermissionRequest`: hook script never throws, server wraps the handler safely, a
  failed POST or app-not-running is swallowed non-blocking — no crash path, nothing left half-open.
- `generateHeadline` failure (timeout, API error) → row keeps its local-derived default summary
  silently. Never blocks the roster, never surfaces an error toast.
- Recap accumulation is pure and side-effect-free; a bug there can produce a wrong *summary*, never
  a crash or a hang, since it never gates anything else.
- Session-mismatch (a `Notification` event from a different, non-pinned session) falls through
  exactly like Stage 6's existing session-mismatch handling — silently ignored, not an error.

## Testing

- `recapAccumulator.ts`'s `accumulate()` — pure, exhaustively unit-tested (dispatch completion,
  anomaly new/cleared, usage delta accumulation).
- `alertSounds.ts`'s new `playNotification` action — decision-mapping logic unit-tested; the actual
  `AudioContext` synthesis is verified live, matching this repo's existing testing philosophy for
  anything requiring a real `AudioContext`.
- `rosterGrouping.ts` — pure, unit-tested (group assignment, `NEEDS INPUT`-first ordering,
  `DONE`-only collapse eligibility).
- `transcriptDensity.ts`'s `applyDensity()` — pure, unit-tested (verbose/normal passthrough,
  summary collapse-to-headline), matching `settingsMath.test.ts`'s existing coverage style for
  other Settings-driven view logic. `RecapBanner.tsx` gets the same shallow render/dismiss test
  treatment as other cards (e.g. `DispatchTimeline.test.tsx`).
- `headlineGenerator.ts`'s throttle gate (`Map` lookup, 15s floor, blocked-bypasses-throttle) is
  pure and unit-tested; the real Haiku call is integration-level, mocked at the request boundary
  the same way `chatCore.test.ts` already mocks Chat's real API path.
- `permissionServer.ts`'s new `onNotification` route gets a test suite mirroring its existing
  `onPostToolUse` integration tests (real local HTTP server, not mocked).
- Session-mismatch and app-not-running fallback for the new Notification route get explicit tests,
  matching Stage 6's stated convention of never letting a silent-failure-shaped branch go untested.

## Explicitly deferred (not this stage)

- Fleet-wide presence/notifications (any session, not just Aether's own) — same out-of-scope
  reasoning as Stage 6's fleet-wide approval deferral.
- Persisting the recap across app restarts — in-memory only, per this stage's scope decision;
  revisit only if a real need for restart-surviving recap emerges.
- A raw/configurable mapping of notification reasons to custom sounds — three fixed reason→tone
  mappings cover the real hook payload's typed reasons; user-configurable sound mapping is a
  polish item for a later stage if ever wanted.
