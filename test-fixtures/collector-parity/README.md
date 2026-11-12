# Cross-collector parity harness

`collector/` (Node) and `collector-go/` are two implementations of the same
Stage 2 contract. `docs/roadmap.md` Stage 10 describes the Go one as a
"drop-in swap" whose cutover is a later decision — so the two must produce
**identical** results, or a cutover silently changes what gets collected.

They did not. Three separate defects found on 2026-08-10 were all the same
shape — a rule applied to one code path and not its sibling:

- The Node collector read nested `subagents/*.jsonl` transcripts but never
  ingested their token usage (#25). 53% of usage events and 28.6% of tokens
  were invisible on a real corpus.
- The Go collector had no `subagents/` handling **at all** (#29) — missing
  usage, tool calls and anomalies alike.
- The pre-existing nested-subagent test asserted tool calls only, so the
  first gap sat next to a passing test.

This harness exists so the next drift fails loudly instead of being found by
reading source.

## How it works

`corpus/` is a committed miniature `~/.claude/projects` tree: one project,
one top-level session transcript, and one nested subagent transcript. Both
carry token usage and a closed tool call, so a collector that skips the
nested path cannot produce the golden figures by accident.

`expected.json` is the golden. Each suite scans `corpus/` into a throwaway
database and asserts against it:

- `collector/src/parity.test.ts` (vitest)
- `collector-go/internal/collector/parity_test.go` (go test)

Neither suite runs the other. They agree by both asserting the same file,
which keeps the check language-agnostic and needs no cross-process
orchestration.

## What it guards

**Row counts and token totals** — catches a collector that skips a path, or
double counts one.

**`transcript_files` keys** — the load-bearing one. Both collectors write to
the *same* database. If they key the same file differently, that file is
scanned twice under two keys and its usage is **double counted** — a worse
failure than the undercount above, because the resulting numbers look
plausible. The golden stores forward slashes and each suite normalises its
platform separator before comparing, so this holds on Windows and POSIX.

## Changing the golden

If a deliberate behaviour change moves these numbers, update `expected.json`
in the same commit and say why in the message. A golden edited to make a red
suite green, without that reasoning, is how a parity harness quietly stops
being one.

## Deliberately not covered

Dispatch rows ARE covered (the `dispatches` block in `expected.json`, from
`corpus/my-project/sess-2.jsonl`): NULL, not 0, for absent usage; the
notification `<status>` parsed into `exit_state` and `dispatch_status`;
severity and the per-agent median baseline; `session_id`, `agent_id` and
`task_kind` from the opening tool_use. Still not covered: the tool-error
floor, the rescore pass, the stale-dispatch sweep, background (async-launch)
dispatches, and Memory Layer 2 extraction. Those are either Node-only today
or not wired in the Go collector, so adding them would encode an expectation
neither implementation is meant to meet.
