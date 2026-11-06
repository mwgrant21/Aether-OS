---
name: afk-preflight
description: Use when Matt says he is going to bed, heading to bed, off to bed or going afk. Prepares an overnight run: shows the standing terms, compiles tonight's list from the handoffs, ledger and plans, asks the clarifying questions, and hands the final confirm and approve steps to Matt.
---

# Pre-flight for an overnight run

You prepare the night list. You never approve it. Matt does that himself in a terminal. Follow the steps in order.

1. Run `node "{{AFK_CLI}}" terms show` and show Matt the terms.
2. Ask which projects tonight covers. The default is this repo's folder name: the handoff folder name, not a worktree name.
3. Run `node "{{AFK_CLI}}" compile --project <name>` before any confirm or amend, because every run starts the draft over and drops every confirmation and amendment. Show the ready, question and barred items.
4. Ask the clarifying questions for the question items: at most 3 rounds of at most 4 questions, then stop and say "no open doubts" or list what stays held. An answer changes nothing in state. When Matt settles a question he edits the source himself (the handoff's Next steps line, the ledger line, or the plan), and then you run compile again after editing the source line, BEFORE any confirm. The edited line is a new item with a new id and nothing is confirmed yet. Two cases one line cannot fix: a question:needs-matt that comes from the handoff's Next steps heading note (for example "(all need Matt)") is cleared by removing that note from the heading, not by editing an item; one that comes from a ledger line's [pending ...] state (for example [pending Matt]) is cleared by changing that state to [todo]. A question about an unapproved spec or a missing plan is settled by approving the spec or adding the plan, then compiling again. Whatever Matt does not settle stays held.
5. Run `node "{{AFK_CLI}}" feasibility`.
6. State back what will run, what is set aside, and which terms apply. Say that confirm prints the allowlist an unfinished night would run on (from the last-approved terms), and that approve prints the exact allowlist rules for Matt to approve, with the two limits printed beside it: the push rule is a prefix, and no Edit or Write rules are included, so file-editing items may go yellow.
7. If Matt edited any source line since the last compile, run compile again first. Then tell Matt to open a plain PowerShell window (not an Aether terminal, which has no TTY) and type these himself: `node "{{AFK_CLI}}" confirm --all-ready` (or specific ids), optionally amend, then approve. Ask him to say "done" afterwards.
8. After Matt says "done", run `node "{{AFK_CLI}}" plan` and report what it returned. If the reason starts with `resolve failed:` report it as an error: it is the catch-all for a code defect, not an ordinary empty night. If the result is unfinished and lists no items, nothing will run. If the result is none, no night is approved.

## Rules

- Never run terms set, amend, confirm or approve. They refuse without a TTY, and trying is a violation.
- Never edit anything under ~/.aether-os/afk.
- Never guess past an ambiguity.
- Never edit or reword a handoff, ledger or plan line to make a question disappear.
- Deletion, force-push and cleanup are never on the night.
- A task Matt names that is in no handoff, ledger or plan is added by him to the handoff's Next steps, and then you run compile again. Phase 1 has no add-item verb.
- An unfinished pre-flight still runs the confirmed items on the last-approved standing terms, and everything else is held.
