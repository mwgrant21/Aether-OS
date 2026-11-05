# AFK / overnight mode for Aether - design (2026-11-04)

Status: APPROVED by Matt 2026-11-04 as written. Nothing is built. Source of truth for what Matt said: `~/.claude/handoffs/aether-os/2026-11-04-afk-mode-brainstorm-notes.md`. Items marked **[Claude's call]** are my choices, not Matt's decisions; check them. Brainstorm notes: ~/.claude/handoffs/aether-os/2026-11-04-afk-mode-brainstorm-notes.md.

## 1. Intent

Matt goes to bed or steps away and the agents in his Aether terminals carry out the work that is already planned, safely, without him. He wakes to a finished plan and a short report, not to stalled terminals or surprises.

Today he retypes a nightly message each time ("work overnight 1am-7am, follow model tiering, three Codex reviews per push, you may escalate to Opus, three failed Opus reviews may escalate to Fable for one turn"). The mode turns that into a standing, reviewable set of terms, a pre-flight that checks understanding, and a safe unattended run.

## 2. A good and a bad morning (the success test)

- **Good:** everything clearly marked on the night's list is done; any expected APK/EXE is built and ready to install; the decisions that were pre-made were carried out; the agents' use of granted autonomy succeeded; Matt starts the day with a clean slate.
- **Bad:** nothing finished because permissions were incomplete or misunderstood, or because the agent did not ask enough questions to understand him.

## 3. Goals, non-goals, anti-goals

Goals
- One AFK mode living inside Aether (the app that hosts the terminals): trigger, pre-flight, unattended run, morning report.
- Hitting one wall never costs the whole night: set the item aside, mark it yellow, carry on.
- A run never silently climbs to, or stays on, an expensive tier.

Non-goals (this design)
- Agents making new major decisions at night. Only pre-made decisions are executed.
- Cloud routines, `--bg`, `bypassPermissions`, multi-machine.
- Phone push (a later extra, see Phase 5).

Anti-goals (a failure even if it technically runs)
- An agent guessing past an ambiguity instead of asking before bed.
- An agent deleting anything without Matt's approval.
- A session locked on Opus/Fable after the escalated work ended.
- A long uncompacted run (the 2026-10-19 limit hits).

## 4. Triggers

Matt types or says "going to bed" or "AFK" (the confirmed phrase list and tense guard in `aether-gui/design-kit-v1.md` part 7 applies). Later, mainly in the GUI, an AFK button starts it immediately. Detection setting Off/On, default On, per-user with per-thread override (already settled in part 7). The 15-minute possible-away wait applies to the short "stepping away" case; a bedtime/AFK trigger goes straight to the pre-flight below. **[Claude's call]**: the pre-flight, not the 15-minute timer, is what arms an overnight run.

## 5. Standing terms (the grant)

A saved settings object that only Matt edits. **[Claude's call]** It is NOT stored as LLM-extracted memory: a grant must never be inferred or written by the extractor (the extractor prompt forbids instructions-to-self, and a wrong inference would widen authority). Memory "option B" (operator turns into memory) is a separate, later piece.

Default terms, from what Matt said:
| Term | Default |
|---|---|
| Window start | 1am; end 7am. The window is when work starts, not a cutoff: in-progress work continues past 7am (Matt prefers "still in progress, on task" to something left incomplete). |
| Push, merge | Allowed. **[Claude's call]** merges only of work that has a refuter ACCEPT for the exact head, via the existing merge-gate. |
| Delete | Not allowed, including post-merge cleanup of branches and worktrees. These queue as "cleanup awaiting approval". |
| Codex reviews | Up to 3 per push, stopping at the first clean one. A third review that is still not clean puts that PR on hold (yellow). |
| Opus escalation | Off unless turned on for the night. **[Claude's call]** (Matt stated the default only for Fable.) |
| Fable elevation | Off unless turned on for the night; if on, one turn after three failed Opus reviews. |
| Notifications | Silent until morning; mobile push optional later. |

Each night the pre-flight shows these terms for approval. One-night amendments apply to that night only and never change the defaults.

## 6. The night's list

Sources: the project's handoffs, remaining tasks and plans that are written and decided, and anything Matt names at bedtime. The pre-flight compiles the list and shows it to Matt. Only written-and-decided items go on it. Anything ambiguous becomes a question, not a guess.

## 7. Pre-flight (the part that prevents the bad morning)

1. Matt triggers the mode.
2. Aether shows the standing terms for approval, with a place to amend them for tonight.
3. The agent compiles the night's list and asks a few clarifying questions until it has no open doubts (bounded; it ends when the agent says none remain).
4. **[Claude's call]** It confirms each item can actually be done unattended (needed tools, accounts, paths and permissions exist; an APK/EXE build can run), so nothing hits a permission wall at 3am.
5. It states back what it will do and what it will set aside. Matt approves once; the night starts.

**If the pre-flight is left unfinished (Matt, 2026-11-04):** the night still runs, on the last-approved standing terms, and only for the items Matt had already confirmed. Unconfirmed or ambiguous items are held and reported as yellow. A one-night amendment that was not confirmed does not apply.

## 8. The unattended run

- **Where it runs (Matt, 2026-11-04):** in new background sessions that Aether manages, not in the interactive Terminal 1/2 panes; the morning report is where Matt sees the results. Aether owns the supervisor that starts, watches and relaunches them (the prototype's fresh-session cycles fit this).
- Executes the list within the written specs; no improvising.
- **Outside the grant or needing more instruction:** set the item aside, mark it yellow, continue with the rest.
- **Failure (red) [Claude's call]:** work that was attempted and failed in a way the allowed retries and ladder cannot fix (build or tests red, crash). After two failed attempts at the same item, set it aside as red; never retry forever. Yellow means blocked by authorization or missing instruction; red means it broke.
- **Context discipline:** each worker has a context/turn ceiling; at the ceiling it writes a handoff and work resumes in a fresh session (the fresh-session-cycle design in `agent-improvement/prototyping-tasks/away-mode-fresh-session-cycles-2026-10-29.md`). Resuming after a context refresh is fine; there is no total-night cap.
- **Tier safety:** escalation is scoped to one task or review and never changes the saved default model (a typed `/model` writes settings.json; use per-dispatch overrides). Every task or fresh session starts by confirming the model it is on. If an agent finds itself on a higher tier after the escalated work ended, it steps back down automatically and notes it in the report (no stop, no yellow).
- **Machine:** assumed always awake and logged in (Matt's constraint).
- Silent: nothing toasts or sounds overnight.

## 9. The morning report

Waiting for Matt, never pushed at him. Three buckets in this order: red (failed), yellow (waiting on you), green (finished), plus: still in progress (live state past 7am), cleanup awaiting approval (branches and worktrees ready to delete, approved in one step), and model step-downs that happened. Each item is a thread/task name and one line; yellow items say what was set aside and which authorization or instruction it needs. It reuses the progressive summary settled in part 7 (first bucket announced, detail on request).

## 10. What exists already (reuse, do not redo)

- GUI away design, settled and unbuilt: `aether-gui/design-kit-v1.md` part 7 (phrases, possible-away, summary, setting).
- Unattended-cycle prototype, partly built: `agent-improvement` `scripts/away-*.ps1`, `pre-kill-check.ps1`, `hooks/session-pid-onstart.mjs`, tests `hooks/tests/test-away-*.ps1`, branches `away-t1-lib` to `away-t6-handoff-write` (merge status unverified). Its "no Opus/Fable, no unattended push/merge" scope rule is superseded by section 5. Its allow/deny list and away-queue ideas map to sections 5 and 9.
- Lesson: an iteration cap is not a time bound (`domains/loop-design/an-iteration-cap-is-not-a-time-bound-...`); the context/turn ceiling in section 8 must be a real bound.

## 11. Build phases **[Claude's call]**

1. Standing terms object, pre-flight dialog, and night-list compiler (text-first, in Aether terminals).
2. Unattended runner: scoped tier escalation with model check and step-down, review budgets, push/merge through merge-gate, delete queue, per-worker context ceilings and fresh-session resume (reuse the prototype pieces).
3. Morning report (data first, then the three-bucket UI).
4. GUI away state: phrase detection, AFK button, banner, setting (part 7).
5. Mobile push notifications (needs the Android port).

Each phase ships and is verified before the next. The first real end-to-end overnight test runs on a throwaway repo, with Matt present, before it touches real work.

## 12. Calls made after the builder check (all **[Claude's call]**, check them)

- **Enforcement is layered, never prompt-only.** The grant is enforced by permission mode + an explicit allowlist and a deny list (delete, force-push, `git branch -D`, recursive remove, writes to the terms file and `~/.claude/away*`), the merge-gate for merges, and the existing Safety Net hook. `bypassPermissions` is never used. "No human at 3am" is handled by the pre-flight approving the allowlist up front; any call outside it is denied and the item becomes yellow.
- **Terms are snapshotted at approval.** The night runs on a copy taken when Matt approves; agents cannot write the live terms file (deny rule), so a tampered file cannot widen that night.
- **Runner architecture is left to the builder**, with this constraint: a supervisor owned by Aether (not loose Task Scheduler scripts) launches, monitors and relaunches the sessions. The `away-*.ps1` prototype is a reference, not a base, until its branches' merge status is verified.
- **Context/turn ceilings are enforced externally** (the runner measures transcript size and turns), not by agent self-report. Starting values: hand off at roughly 160k tokens of context (matches the existing handoff nudge) and the prototype's 40 turns per cycle; builder to tune.
- **The night's list:** handoffs in `~/.claude/handoffs/<project>/` (Next steps), ledgers, and plans with an approved spec. "Decided" means it is in an approved spec/plan or a handoff's Next steps, and Matt's approval of the compiled list at pre-flight is the final gate. Scope is the project(s) of the running terminals plus any Matt names at bedtime.
- **Codex review** means the GitHub Codex bot review on the PR (triggering `@codex review` is covered by Matt's "three reviews approved"). "Clean" = a review posted with no findings and no unresolved threads, using the rules in `agent-improvement/loops/pr-review-watch/LOOP.md`.
- **Opus trigger** is the standing one: a Sonnet result that missed twice. The per-night Fable toggle is Matt's explicit override of the standing "Fable is OFF" rule for that night only; the standing rule is unchanged otherwise.
- **Builds (APK/EXE)** use each project's own recipe (e.g. aethermobile needs the Titan tailnet IP property; Aether packaging builds outside the dev tree). The feasibility check is per-project and reads those recipes; builder to enumerate them.
- **Clock** is the machine's local time (MST). The morning report is a file first (the data), shown in the terminal and later the GUI.

## 13. Open items for Matt

- Settled by Matt after the builder check: unfinished pre-flight runs confirmed items on the last-approved terms; overnight work runs in managed background sessions.
- Confirm the **[Claude's call]** items: Opus off by default; merges only after refuter ACCEPT via merge-gate; red = failed after two attempts; the pre-flight arms overnight (not the 15-minute timer); the item-feasibility check in step 4; the phase order.
- Whether force-push counts as "delete" (my call: barred).
- Where the pieces live between the Aether-OS app and the aether-gui lane (the doc treats it as one mode; the builder will split by directory).
