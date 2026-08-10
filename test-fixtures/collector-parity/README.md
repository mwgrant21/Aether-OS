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
- `collector-go/internal/transcript/parity_test.go` (go test)

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

Dispatch completions and Memory Layer 2 extraction. Both are top-level-only
in the Node collector by design — a dispatch completion appears in the
*parent* transcript, not in the subagent's own file — and neither is wired
in the Go collector yet. Adding them to this golden would encode an
expectation neither implementation is meant to meet today.
