---
name: aether-terminal-board
description: Use inside an Aether terminal (Alpha or Beta, where AETHER_TERMINAL is alpha or beta): at the start of a task, before editing or waiting on any PR, branch, worktree or file you were not assigned, and when a task ends. Tells you how to use the shared terminal board so two terminals do not collide.
---

# Terminal board: stay out of the other terminal's way

Aether keeps one small board file per terminal (Alpha, Beta). You read and write it only through a CLI. The board is advisory: nothing blocks your tools, so following it is on you. Follow the steps in order.

1. Run `echo "$AETHER_TERMINAL"`. Only `alpha` or `beta` means you are in an Aether terminal. Empty means you are not: stop here, do not use the board, and never write board files by hand. The Codex terminal has no board.
2. Find the CLI and remember the path for the session. Test each candidate with `ls` and use the first that exists (forward slashes, always quoted):
   - `<git toplevel>/scripts/aether-board.mjs` when the current directory is inside an aether-os checkout (`git rev-parse --show-toplevel`).
   - `"$LOCALAPPDATA/Programs/Aether OS/resources/scripts/aether-board.mjs"` (installed build default).
   - Neither exists: tell Matt "aether-board CLI not found", carry on without the board, and do not create files under `~/.aether-os/terminal-board`.
   Below, `BOARD` is that path. Run it as `node "BOARD" <verb> ...`. In CLI messages, `aether-board` means `node "BOARD"`.
3. `node "BOARD" whoami` prints `alpha` or `beta` (exit 2 means not an Aether terminal). Use it to answer "which terminal am I".
4. At task start run `node "BOARD" task "<short label>" --project <project> --status working`, then claim everything you will change or own: `node "BOARD" claim pr 155`, `node "BOARD" claim branch <name>`, `node "BOARD" claim worktree <project-relative path>`, `node "BOARD" claim file <project-relative path>` (optional `--note "<short>"`). Exit 3 is a CONFLICT: see step 6.
5. Before touching or waiting on any PR, branch, worktree or file you were not assigned, run `node "BOARD" status` first. Anything under the other terminal that is not marked stale is theirs.
6. If the other terminal holds it (claim exit 3, or seen in status): do not edit it, comment on it, push to it, merge it or rebase it. Do not wait, poll or sleep for it. Run `node "BOARD" blocked '<ref as printed>'` and continue with other work of your own. If you have none, run `node "BOARD" task "<short label>" --status blocked`, tell Matt what is blocked and by whom, and stop.
7. A stale entry (status shows `stale`, over 4 hours old) does not block you; the claim goes through. Only board writes refresh the heartbeat, so on work running past about 3 hours re-run your `task` command so your own claims do not go stale.
8. When a PR is merged or closed, or you finish, run `node "BOARD" release <ref>` for each claim. When idle, run `node "BOARD" clear`.

## Privacy rules (binding)

- Refs are PR numbers, branch names or project-relative paths. Never an absolute path, a drive letter, `~`, a `file:` URL or a `..` segment.
- Titles and notes are short labels. Never prompts, command text, tool output or secrets. No newlines.

## Rules

- Never write or edit the other terminal's file, or anything under `~/.aether-os/terminal-board`, yourself. Use the CLI only.
- Exit codes: 0 ok, 1 usage or validation, 2 no identity, 3 conflict, 4 write failed. On 4 tell Matt; do not retry in a loop.
