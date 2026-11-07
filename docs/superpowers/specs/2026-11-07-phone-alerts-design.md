# Phone alerts (Aether Mobile) - design

Date: 2026-11-07. Status: DRAFT, builder check done, owner decisions folded in; awaiting owner approval of the full text. Written against origin/master e8a13b4.
Binding companion: `docs/privacy-and-data.md` section 17 (this design changes it; the doc
change lands before any capability code, per this repo's rule).

## Intent and the why

The owner is often away from the desk while Claude runs. Two costs recur:

1. Claude finishes, or stops to ask something, and the owner does not know. The run sits idle
   until they happen to look at the phone. Wasted time is the whole complaint.
2. When it is a simple yes/no ("Should I clean the worktrees? Y/N?"), typing the answer on the
   phone is slower than it needs to be (slice 2, not this design's build scope).

This design covers only the first cost: the phone tells the owner, promptly, that a Claude
terminal is waiting. Vibration and sound are expected later layers on the same signal.

## Goals

- When the Claude process in Alpha stops and waits for the owner, the phone raises an
  Android notification within seconds, even if the Aether app is backgrounded or the phone is
  locked.
- Three kinds of alert, shown with fixed wording the desktop cannot alter:
  - finished: "Task finished"
  - question: "A question needs your attention"
  - input: "Input needed for clarification"
- Lock screen shows the terminal's name and kind only, for example "Terminal Alpha has a
  question" / "has finished" / "needs input". Nothing else.
- Fires every time Claude stops and waits (owner's decision; no duration threshold, no quiet
  period).
- The existing main connection keeps its behaviour unchanged: fingerprint to unlock, drops
  after about a minute in the background. The owner values that and it is not to be weakened.

## Non-goals (this design)

- Green/red yes/no buttons (slice 2, designed separately after this ships).
- Allow/Deny on Claude permission prompts (later; bigger risk, needs an approve verb and risk
  tiers; privacy section 17 calls it R3).
- Beta terminal alerts (second slice, after Alpha is tested)
- Codex terminal alerts (Codex leaves no transcript, so "waiting" would be a guess from the
  terminal going quiet; owner deferred it to a later to-do).
- Vibration and sound patterns (later; the signal this builds is what they will hang on).
- Any desktop-side alert or notification change.
- Google push (FCM) or any third-party delivery.

## Anti-goals (a failure even if it technically works)

- Any alert text derived from terminal, transcript, tool, path or question content, on the wire
  or on screen. The notification must be structurally unable to leak, not merely careful.
- The alert credential being usable for anything except receiving alerts.
- Weakening the fingerprint lock or the main connection's background drop to make alerts work.
- Routing terminal state through Google or any server outside the tailnet.

## Decisions (the owner's, as made)

- Delivery model: a separate, weaker, alert-only credential and connection. The main
  connection stays locked behind the fingerprint. Rejected: keeping the main connection alive in
  the background (longer exposure of an unlocked token); alerts only while the app is open
  (does not solve "I did not check my phone").
- The alert credential can receive alert signals and do nothing else: no terminal output, no
  thread, no ledger, no views, no input, no prompts.
- Alert text is a closed set of fixed strings (above). Lock-screen text is the terminal name
  plus the kind.
- First version covers Alpha only. Beta follows in a second slice after Alpha is tested on the device (owner, 2026-11-07). Beta needs a new transcript follower and session resolver, which does not exist today.
- A desktop watcher may run whenever alerts are enabled in Settings, even with no phone connected (owner: "always allow"). It reads transcripts locally and emits only a fixed label. Privacy section 17 must say this in place of "nothing runs when detached". My reading: it is tied to an alerts switch in Settings (default off) rather than running unconditionally; the owner should confirm that wording.

## My calls (the owner has not decided these; flagged for review)

- The alert credential is issued in the same pairing action as the main credential (one desktop
  click and QR, two tokens), so there is no second pairing ritual. The builder confirms whether
  this fits the existing single-paired-app rule (`CONTROL_MAX_DEVICES = 1`, pairing replaces).
- Android side: a foreground service holds the alert connection and shows a small persistent
  "Aether watching" notification (required by Android for a background service). Lock-screen
  visibility of alert notifications is set to private/hidden-content so only the generic
  fixed text shows.
- Classification of "question" versus "finished" versus "input needed" happens on the desktop,
  from the last assistant message of the stopped turn, and is reduced to one of the three
  labels before it leaves that code. Only the label crosses the wire. If classification is
  uncertain it chooses "input" (a stop that ended on a question mark or a yes/no cue is
  "question"; a plain completed statement is "finished"). A wrong label costs the owner a glance
  and exposes nothing.
- "Stopped and waiting" builds on the turn-end detection behind the phone's `working` flag
  (`threadFeed.ts`, `turnMark` in `threadParser.ts`). CORRECTION after builder check: that
  detection exists for the Claude slot (Alpha) only (`ThreadSlotId = 'claude'`); Beta has no
  transcript follower or session resolver, so Beta alerts are a new subsystem (see Open
  questions). `turnMark` marks idle on any non-empty stop reason, a text-only assistant line, or
  an interrupt; the 120 s stale rule also drops `working`. So: alert on a debounced busy->idle
  edge (a few seconds, builder tunes), not on the raw mark; no alert on a user interrupt
  (the owner caused it); the 120 s stale drop must never produce a second alert for a stop.
- A pending permission prompt (the `permissionBroker` already holds them) also raises the
  "input" alert, with no Allow/Deny (non-goal). Claude is blocked mid-turn there and no turn-end
  ever fires. Alert text stays the fixed "Input needed" wording.
- Sockets: alert-scope sockets are counted separately from `CONTROL_MAX_SOCKETS = 2` so the main
  reconnect is never refused. The alert credential needs its own scope or store: issuing two
  tokens under `CONTROL_MAX_DEVICES = 1` would evict the first as the code stands (remoteAuth.ts
  eviction loop), so this is real work, not a tweak.
- Wire: one server->phone frame (for example `alert {s, kind}`). It must be added in all three
  mirrors (`CONTROL_MESSAGE_TYPES`, `protocol/mobile-protocol.json`, Android `ControlProtocol.kt`)
  and satisfy `controlBoundary` rule 3. An alert-scope socket is closed on any other verb.
- Android has no service, notification or foreground-service permission groundwork today. If the
  owner denies the Android 13+ notification permission the app shows an in-app notice that
  alerts are off. The persistent service notification reads "Aether watching" when connected and
  "Aether not connected" when the PC is unreachable, so failure is never silent.
- Alerts exist only while phone control is on; after a PC restart they resume only if the
  existing "re-enable phone control at launch" setting is on.
- A stop produces at most one alert; a reconnect does not replay old alerts (no stored alert
  queue on the PC; if the phone was unreachable, the alert is not delivered later).

## Constraints

- Privacy and boundary rules in CLAUDE.md and privacy section 17 apply. Same tailnet-only
  listener (no new bind). The message set is a closed allow-list guarded by
  `controlBoundary.test.ts`; a new verb or frame fails that guard until the list, a test, and
  the doc change together. A new credential scope must also be covered by the guard.
- The alert credential is stored hash-only like the device token, bound to the phone's tailnet
  address, revocable from the desktop alongside the main one (REVOKE / REVOKE ALL), and off when
  phone control is off.
- No alert content, timing log or terminal name is written to disk or `diag.log` beyond
  metadata-only fixed-string lines in the existing style (for example `control: alert sent
  kind=<finished|question|input>`; never the terminal's text).
- Docs: update section 17 (Exposed, Never exposed, Boundary, Auth, On disk, Visibility, Limits),
  the CLAUDE.md architecture note, and PROGRESS.md in the same change as the capability.
- Treat as R3 in review: this adds a credential and a background listener-facing path.

## Left to the builder

- Wire format and verb names for the alert channel, the exact credential scope mechanism, and
  how the alert connection authenticates (must meet the hash-only, peer-bound, revocable
  constraints above).
- Where the turn-end hook point lives on the desktop and how per-slot Alpha/Beta mapping is done.
- The Android service lifecycle details (start on pair/boot or after first unlock, reconnect
  policy, Doze behaviour) and notification channel setup.
- Tests: protocol/boundary guards, a classifier table test, a no-duplicate-alert test for the
  120-second idle rule, and Android JVM tests where the logic is pure.

## Open questions for the owner

None blocking. Confirm the reading in Decisions that the watcher is tied to a Settings alerts switch.

## Open items to verify during build, not decide now

- Android Doze/battery-optimisation may delay a foreground-service socket; the build should
  measure delivery latency on the S25 and report it, not assume it.
- The owner referred to the terminals as Alpha and Beta; the phone's existing labels for the
  slots should be reused as-is.
