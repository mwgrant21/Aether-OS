# Removing the user-wait subtraction from measured dispatch duration

**Date:** 2026-09-16
**Status:** Implemented — `src/shared/waitClock.ts` deleted
**Supersedes:** the wait-clock design that shipped with the narration duration baseline
**Closes:** #83

## Read this before rebuilding it

If you are here because a dispatch's duration looks inflated when the operator
walked away, and you are about to reintroduce a "subtract the time we were
blocked on a human" mechanism: **that was built, shipped, and removed.** It was
not removed because it was unfinished or because nobody got round to scoping it.
It was removed because it cannot be made correct with the data this app can see,
and because every correction it actually made was wrong.

The rest of this document is the evidence. If you can refute the measurements
below on today's data, the idea is back on the table. If you cannot, it is not.

## What the mechanism did

`electron/main.ts` kept a process-lifetime `WaitClock`. A permission prompt or a
post-tool flag review opened an interval when the prompt reached the renderer
and closed it when the operator answered, abandoned it, or the handler threw.
When a dispatch completed, `activeDurationMs` subtracted any interval
overlapping that dispatch's span from its wall-clock `<duration_ms>`, and the
corrected figure was fed to `formatNarration` and recorded into
`narrationDurationBaseline`.

The intent was sound: `<duration_ms>` is wall clock, so comparing a run that sat
waiting on an approval against a median of other runs manufactures confident
"slower than usual" narrations whose real cause is that nobody was at the
keyboard.

## Why it was wrong

Ownership was never recorded. `activeDurationMs` subtracted **by time overlap
alone** — any interval intersecting the dispatch's span counted, regardless of
which dispatch (if any) that prompt belonged to. Two consequences:

1. **A main-thread prompt does not block a running dispatch.** Dispatches run
   asynchronously. If the operator is answering a prompt on the main thread
   while a subagent works, the subagent's wall-clock duration is entirely
   unaffected — but the wait was subtracted from it anyway, making it read as
   faster than it was.
2. **The error compounded.** The corrected figure went into
   `recordDuration(narrationDurationBaseline, ...)`, so an under-measured
   dispatch lowered the median every later dispatch of that type was compared
   against — silently, and with no anomaly to notice, since the failure
   direction is "looks fast".

## Why it could not be fixed by scoping it

The obvious fix is to record which dispatch each wait belongs to and subtract
only owned intervals. The identity needed for that does not exist.

**Measured on 2026-09-16, on the machine this app runs on:**

| Probe | Result |
|---|---|
| `isSidechain: true` lines across **570 transcripts / 549 MB** (entire local history) | **0** |
| New transcript file created for a live subagent dispatch | **none** |
| The subagent's own tool calls (two sentinel `Bash` calls) found in any transcript | **none** |
| `parent_tool_use_id` field present on any line | **absent** |
| `Agent` dispatches in a 6,114-tool-call sample | 243 (~4%) |

The probe dispatched a real subagent that ran two `Bash` calls carrying a unique
sentinel, snapshotting all transcripts before and after. The dispatch itself
appears as one `Agent` tool_use. **Its inner tool calls appear nowhere** — not
as sidechain entries in the parent transcript, not in a transcript of their own.

So:

- A permission prompt raised **inside** a dispatch carries the `tool_use_id` of
  an inner call that is recorded nowhere. There is no `parentUuid` chain to walk
  back to the owning `Agent`, because the record does not exist. Attribution is
  impossible, not merely awkward.
- A permission prompt raised on the **main thread** is attributable, and belongs
  to no dispatch — so the correct amount to subtract from any dispatch is zero.

That leaves exactly one attributable case: a prompt for the `Agent` call itself,
where `tool_use_id` *is* the dispatch id. It does not occur here —
`defaultMode: auto`, no `Agent`/`Task` rule in any settings file, and a live
dispatch during the probe raised no prompt at all.

**The baseline this fed is keyed by `subagentType` — it exists only for subagent
dispatches. A subagent's own prompt is precisely the unattributable case.**
Scoping the subtraction correctly therefore turns the feature into a no-op for
its own motivating case, while removing the only corrections it was making, all
of which were taken from dispatches that had not waited.

## What replaced it

Nothing. `main.ts` records `c.durationMs` — wall clock — directly.

## What we knowingly gave up

The original problem is real and is now unmitigated: a dispatch that genuinely
sat blocked on an approval will read as slower than its peers, and may narrate
as an anomaly whose true cause is that the operator stepped away. This is a
known gap, accepted deliberately, because the mechanism that claimed to address
it never addressed it for subagent dispatches and corrupted the baseline in
exchange.

## What would have to change for this to be viable

Do not reopen this on the strength of an idea. Reopen it only if a measurement
shows the attribution data now exists:

1. Subagent tool calls appear in a readable transcript — `isSidechain: true`
   entries in the parent, or a per-subagent transcript file — **and** carry a
   link back to their owning `Agent` tool_use id. Re-run the probe in
   "Why it could not be fixed by scoping it" and get a non-zero answer.
2. Or the PermissionRequest hook payload gains a field naming the owning
   dispatch. Note `scripts/aether-permission-hook.mjs` already receives
   `tool_use_id` for PermissionRequest and drops it (it forwards only
   `tool_name`/`tool_input`); forwarding it is cheap, but on its own it buys
   nothing, because that id identifies the inner call, not the dispatch.

Either way the first step is a measurement, not a design. The failure mode this
document exists to prevent is reasoning from "the intent is obviously right"
to an implementation, without checking whether the data required to make it
right is recorded anywhere.
