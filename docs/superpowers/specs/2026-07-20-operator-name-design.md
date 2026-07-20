# Customizable Operator Name — Design

## Context

"operator" appears across 8 files in this codebase, in three functionally distinct roles,
confirmed by a full grep before writing this spec:

1. **Display-only chrome** — `TopBar.tsx`'s operator chip (`<div>operator</div>`, line 107),
   under which sits a static "COMMAND DECK" subtitle. Purely cosmetic today.
2. **Chat addressing** — `systemPrompt.ts`'s `AETHER_VOICE` constant
   (`'You refer to the user as "Operator."'`) is the **only** place in this app that instructs
   the model to address the user by name. Confirmed by grep: `personas.ts` (the per-agent
   voice strings consumed by every non-AETHER channel) never mentions addressing the user at
   all — today, only AETHER-channel replies use "Operator"; every per-agent chat reply is
   personality-flavored but never speaks to the user by name.
3. **Unrelated uses of the literal string, not a display name** — the terminal's shell-style
   prompt (`operator@aether-core:~$` in `commands.ts`'s `runCommand` and three places in
   `TerminalView.tsx`) is a stylized Unix-username convention, and Memory's `remember` command
   tags manually-created memories with `source: 'operator'` (`commands.ts`, `initialState.ts`)
   as a semantic label distinguishing them from agent-created memories. Neither is a "display
   name" in the sense this feature addresses — explicitly out of scope (see Non-goals).

`AetherState` has no field representing the user's own name today — "Operator" is a bare
string literal wherever it appears, not derived from state.

## Goal

Let the user set their own name once (in Settings), and have it used everywhere the app
currently hardcodes "operator"/"Operator" as a **display name**: the TopBar chip, and the
instruction that tells the model how to address the user — extended, as part of this work, to
every chat channel (not just AETHER, which is the only one that does this today).

## Non-goals

- **The terminal's shell-style prompt** (`operator@aether-core:~$`) stays exactly as it is.
  It mimics a real `user@host:~$` prompt; a free-text display name (spaces, punctuation,
  arbitrary length) isn't safely droppable into that position without a separate
  sanitization step this feature doesn't need to take on.
- **Memory's `remember` command `source: 'operator'` tag** stays exactly as it is — a semantic
  label distinguishing manually-created memories from agent-created ones (`kill`,
  HIGH-approval triggers use the agent's own name as `source`), not a display name. Renaming
  it would blur that distinction without adding real value.
- **No new persistence bug to fix** — unlike most prior plans in this project, there is no
  pre-existing gap to find here, because `operatorName` doesn't exist as a field yet. Its
  persistence-whitelist entry is added proactively as part of this plan, not discovered later.
- **No name validation beyond a `maxLength` on the input.** No profanity filtering, no
  uniqueness check (there's nothing to be unique against — this is a single-user app), no
  requirement that the name look like a "real name."

## Architecture

### State changes

- New `AetherState` field: `operatorName: string`, seeded in `initialState.ts` as `'Operator'`
  — matching the exact string `systemPrompt.ts` hardcodes today, so the very first render/reply
  after this ships is byte-identical to before it.
- New reducer action: `{ type: 'SET_OPERATOR_NAME'; name: string }`. Reducer case:
  `return { ...state, operatorName: action.name };` — no trimming/validation in the reducer
  itself (the *display*/*prompt* consumers resolve blankness, not the stored value — see
  below), matching this app's general pattern of not adding reducer-side validation for things
  only a UI control can produce (same reasoning as `UPDATE_CFG`'s numeric fields being
  range-validated only by their `<input type="range">` elements).
- `operatorName` added to `persistence.ts`'s `savePersisted` whitelist.
- This is a single top-level field, not a `Cfg` field — it does not go through `UPDATE_CFG`,
  matching how `selectedProject`/`selectedMemory`/`routeDefault` (other single top-level
  fields) each got their own dedicated action rather than being folded into an existing
  multi-field patch action.

### `resolveOperatorName` (new, in `src/utils/format.ts`)

```ts
export function resolveOperatorName(name: string): string {
  return name.trim() || 'Operator';
}
```

Added alongside this file's existing tiny pure helpers (`fmt`, `short`, `fmtEta`, `spark`,
`nowLong`, `nowShort`) rather than as a new dedicated module — it's a single one-line function,
and `format.ts` is already this codebase's home for small display-formatting helpers with no
state of their own. Used in exactly two places (below), which is what makes extracting it worth
doing instead of duplicating the trim-or-fallback logic — a user who clears the field entirely
(even transiently, mid-edit) never causes a blank chip or an empty chat instruction, without the
reducer forcibly overwriting what they're actually typing.

### `TopBar.tsx`

Change:

```tsx
<div style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textPrimary }}>operator</div>
```

to read `{resolveOperatorName(state.operatorName)}` instead of the literal `operator`. The
"COMMAND DECK" subtitle beneath it is unchanged.

### `systemPrompt.ts`

- New shared helper, `referAsInstruction(operatorName: string): string`, returning
  `` `You refer to the user as "${resolveOperatorName(operatorName)}."` `` — the exact sentence
  AETHER already hardcodes today, now the **single** place that sentence's wording lives. Both
  the AETHER branch and the per-agent branch call this one function rather than each building
  their own copy of the sentence, so they can never drift apart in wording (only the resolved
  name varies between calls, and both calls read the same `state.operatorName`).
- `AETHER_VOICE` changes from a static constant to a function,
  `aetherVoice(operatorName: string): string`, returning the same voice string as today with
  its trailing sentence replaced by a call to `referAsInstruction(operatorName)`. `state` is
  already passed into `buildSystemPrompt` for both branches, so no new parameter is needed to
  thread the name through.
- **New for per-agent channels** (this is the part that's actually new behavior, not just a
  parameterization of existing behavior): both of the per-agent branch's returns (the normal
  case and the archived-channel fallback) get `referAsInstruction(state.operatorName)` appended
  to their persona-voice string, so every agent channel now addresses the user by name too —
  closing the gap the Context section identified, where only AETHER did this before.

### `OperatorCard.tsx` (new, in `src/components/settings/`)

A single labeled text input:

```tsx
<input
  type="text"
  maxLength={24}
  value={state.operatorName}
  onChange={(e) => dispatch({ type: 'SET_OPERATOR_NAME', name: e.target.value })}
/>
```

Dispatches on every keystroke (same immediate-feedback convention as Settings' existing range
sliders — no separate "save" step anywhere else in this app's Settings view). Added as a third
card in `SettingsView.tsx`'s left column, stacked with `OperatingModeCard`/`BudgetAlertsCard` —
"identity" is a distinct concern from operating-mode or budget/alerts, not a natural fit inside
either existing card.

## Data flow

Settings' `OperatorCard` dispatches `SET_OPERATOR_NAME` → `state.operatorName` updates →
`TopBar.tsx`'s chip re-renders immediately (same store, no reload) → the next chat message sent
in Chat (any channel) builds its system prompt from the updated `state.operatorName` via
`buildSystemPrompt`, so the very next reply — from AETHER or any agent — addresses the user by
the new name.

## Error handling / edge cases

- **Empty/whitespace-only `operatorName`**: `resolveOperatorName` falls back to `'Operator'`
  for both display and prompt purposes; the stored value itself is never forcibly overwritten
  (the user can keep typing without the field snapping back mid-edit).
- **A name longer than 24 characters**: prevented at the input level via `maxLength` — no
  reducer-side truncation needed.
- **Archived chat channels**: the archived-channel fallback branch in `buildSystemPrompt` gets
  the same new addressing sentence as the normal per-agent branch — verified explicitly in
  Testing below, since it's easy to update one branch and miss the other.

## Testing

**Unit:**
- `resolveOperatorName` (in `format.test.ts`): returns the input trimmed when non-blank,
  returns `'Operator'` for an empty string, returns `'Operator'` for a whitespace-only string.
- `SET_OPERATOR_NAME` (in `reducer.test.ts`): sets `operatorName` to the given value verbatim
  (no trimming at the reducer layer), leaving the rest of state untouched.
- `persistence.test.ts`: `operatorName` round-trips through `savePersisted`/`loadPersisted`.
- `systemPrompt.test.ts`: AETHER's prompt contains the custom name (not the literal word
  "Operator") when `state.operatorName` is set to something else; a per-agent channel's prompt
  (both the normal and the archived-channel-fallback branch) now also contains the custom name,
  closing the gap where per-agent replies never addressed the user before this plan.

**Manual GUI QA (plan-exit, per this project's convention):**
1. Settings' new identity card renders with the current `operatorName` (default "Operator") and
   accepts typed input.
2. Typing a new name updates the TopBar chip immediately, with no reload.
3. Switch to Chat, message AETHER — confirm the reply addresses the user by the new name in a
   natural sentence (not literally echoing "Operator").
4. Message a per-agent channel (e.g. Code Builder) — confirm it also now addresses the user by
   the new name, which it never did before this plan.
5. Clear the name field entirely — confirm the TopBar chip falls back to "Operator" rather than
   going blank, and a subsequent chat reply still addresses the user (as "Operator", the
   fallback) rather than producing an awkward blank-name sentence.
6. Reload the page — the custom name persists in both the TopBar chip and the next chat reply.
7. Confirm the terminal's `operator@aether-core:~$` prompt and Memory's `remember`-tagged
   `source: 'operator'` are both unchanged by any of the above (non-goals held).
