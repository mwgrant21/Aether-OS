# Collector write-path hardening + mutation baseline

**Status:** shipped, 2026-09-07. Six PRs merged to master. Six follow-up issues open.
**Written as a handoff** so this can be picked up on another machine without the
originating session. Everything needed to resume is either in this repo or named below.

---

## What this was

Two separate threads that turned into one:

1. **A mutation-testing baseline for `collector/`** — how good the collector's tests
   actually are, measured with Stryker rather than assumed from a green suite.
2. **The write path for the user's real `~/.claude/settings.json`** — which the
   mutation run exposed as under-tested, and which then turned out to be wrong in
   several ways across all three processes that write it.

## What shipped

| PR | Closes | What |
|---|---|---|
| #57 | — | 31 tests for `hookInstaller`/`spoolTailer`; fixed a crash on a `null` entry in a hooks array |
| #61 | #58 | Refuse a top-level `hooks` that is not a plain object (an array was silently rewritten into `{"0":…}` with `ok:true`) |
| #62 | #59 | Never leave a `.aethertmp-*` file behind, on any failure path |
| #64 | #60 | Unique, exclusively-created backup names (a same-millisecond collision overwrote the user's pristine backup) |
| #68 | #66 | `electron/atomicWrite.ts` + `electron/guidanceWriter.ts`; the CLAUDE.md writer brought onto the same contract |
| #70 | #63 | The collector's TS and Go copies brought onto that contract; drift now fails CI |

## The contract, in one place

Three processes write `~/.claude/settings.json`: the Electron app, the TS collector,
and the Go collector. A fourth path (`optimize:apply`) writes `CLAUDE.md`. They now
share one set of rules, because a difference between them is a bug by definition.

The reference implementation is **`electron/atomicWrite.ts`**.
`collector/src/atomicWrite.ts` is *generated from it* and is byte-identical modulo
imports and comments — `electron/atomicWrite.parity.test.ts` fails CI if they drift.
`collector-go/internal/hookinstall/installer.go` implements the same rules by hand.

A rename gives a **new inode**, so everything attached to the old one must be
re-created deliberately. The rules, in the order they execute:

1. **Resolve symlinks**, including a **dangling** link (resolve to its intended
   destination, not the link), depth-capped against loops.
2. **Preserve the file mode**, and set it **at creation** — creating under the umask
   and narrowing afterwards leaves a window where another local user can open the
   temp file and keep the descriptor.
3. **Refuse a read-only target.** A rename is governed by the *directory's*
   permissions, so it would otherwise silently bypass protection the user set.
4. **Write a hard-linked target in place.** A rename severs the link and leaves the
   other entry on the old inode with stale content. This deliberately trades back the
   truncation window: the caller has already taken a backup, and a truncated file is
   visible where a severed link is not.
5. **Exclusive create** (`wx` / `O_EXCL`) of a temp name carrying timestamp + pid +
   random bytes, so a cleanup can only ever remove a file this invocation created.
6. **Clean up the temp file** on any failure — except a lost exclusive create
   (`EEXIST`), where the file belongs to another writer.
7. **Backups** use the same unique exclusive naming, so one can never overwrite an
   earlier one.

**What this does NOT give you.** "Atomic" here means atomic with respect to concurrent
*readers*; it is not durable, because nothing is fsynced. ACLs, Windows DACLs,
ownership and xattrs are not preserved — Node and Go both expose only `chmod`/`chown`
(see #69). These limits are stated in the module doc comments too.

## The mutation baseline

Measured 2026-09-07 at `bf427b0`, 8 files, 715 mutants, concurrency 3, zero timeouts.

| File | Score | Status |
|---|---|---|
| hookInstaller.ts | 59.7% -> ~92% | done (#57) |
| spoolTailer.ts | 81.8% -> 88.6% | done (#57) |
| staleDispatchSweep.ts | 90.5% | **not started** |
| retention.ts | 88.6% | not started (already high) |
| toolCallHistory.ts | 75.9% | **not started** |
| transcriptScan.ts | 72.2% | **not started** |
| ingest.ts | 71.2% | **not started** |
| promptSafety.ts | 73.7% | **not started** |
| **overall** | **70.1%** | fleet baseline for comparison: 96.9% (efi-diagnostic) |

The surviving mutants for the untouched files are listed in
[`2026-09-08-collector-mutation-survivors.md`](./2026-09-08-collector-mutation-survivors.md),
which is the actual worklist for resuming.

### Re-running it

```bash
cd collector
npx --yes -p @stryker-mutator/core@8 -p typescript@5 stryker run stryker.collector.json
# one file only, for a fast check after adding tests:
npx --yes -p @stryker-mutator/core@8 -p typescript@5 stryker run stryker.collector.json --mutate src/ingest.ts
```

`collector/stryker.collector.json` is committed and uses **relative paths**, so it
works on any machine. The JSON report lands in `collector/reports/` (gitignored).

**Three gotchas, each of which cost real time:**

- **Cap `concurrency`.** Stryker defaults to CPU count minus one, and the command
  runner executes the *whole* vitest suite per mutant, which itself uses every core.
  On a 24-core box that oversubscribed the machine and timed out 629 of 715 mutants.
  Timeouts count as *killed*, so the console reported a false **96.6%** where the
  honest number was **70.1%**. The committed config pins `concurrency: 3`. If a run
  reports a large timeout bucket, do not trust the score.
- **Do not run it from inside the Aether dev app.** Stryker's sandbox contains a
  rewritten `tsconfig.json`; Vite watches the repo root and force-reloads the renderer
  on any `tsconfig.json` add/unlink, which re-runs the terminal's module-level
  `pty.start()` and kills the embedded session mid-run. Run it from a plain terminal.
- **`src/parity.test.ts` is excluded** in the config. Its fixture lives at the repo
  root, outside the collector package, so Stryker's sandbox copy never contains it.
  It is a cross-implementation contract test, not coverage of the mutated files, so
  excluding it does not distort the score.

## Open issues

| # | What | Notes |
|---|---|---|
| #65 | Go stores `null` `session_id`/`severity` on dispatch rows where Node stores values | Found by running the parity harness, which is **not** in CI. Decide which side is right. |
| #67 | A backup truncated by ENOSPC is left in place | Not data loss (install aborts before the target is touched), but indistinguishable by name from a good backup. |
| #69 | ACLs/xattrs are not preserved by an atomic replace | Not implementable in Node or Go without shelling out to `icacls`/`setfacl` per write. Documented, not fixed. |
| #71 | The backup inherits the umask, not the source file's mode | A `0600` settings.json gets a `0644` backup beside it. Shared by all three copies — fix together. |
| #72 | The symlink depth cap returns the wrong path | At the cap it returns the current hop, so a >32-deep chain replaces an intermediate link. Identical in all three, so not a parity defect. No test. |
| #73 | No installer-level integration test for the symlink case or the EACCES string | All coverage is at the `atomicWrite` unit level; nothing pins the delegation or the error text the Go port replicates by hand. |

**Suggested order to resume:** #71 and #72 together (both touch all three copies, both
small), then #73, then the mutation worklist. #65 is independent and needs a decision
before code. #69 is a documented limitation, not work.

## Verifying a change to any of this

```bash
# Runnable as written, from the repository root. Each cd is in a subshell so the
# next line does not start from the previous one's directory.
npx vitest run                                        # root: renderer + electron
(cd collector && npx tsc -b && npx vitest run)        # collector package
(cd collector-go && gofmt -l . && go vet ./... && go test ./...)
(cd collector-go && GOOS=windows go build ./...)      # linkcount_windows.go has no other lane
npm run typecheck:electron && npm run build && npm run electron:build
```

`gofmt` takes filesystem **paths**, not the `go` tool's `./...` package pattern --
`gofmt -l ./...` exits 2 and takes the rest of the chain down with it. `gofmt -l .`
recurses and only lists; `go fmt ./...` also works but rewrites files, which is the
wrong thing for a verification step.

**The parity harness is the one that matters for any write-path change**, and it is
not in CI:

```bash
(cd collector && npm run build)    # the harness runs the BUILT Node collector
(cd collector-go && node scripts/parity/run-parity.mjs)
```

It takes ~2 minutes and diffs the Node and Go collectors row-for-row plus their CLI
hook-install/uninstall and autostart output. As of 2026-09-07 its only reported
divergence is #65.

## What is NOT in this repo

- **The raw Stryker reports and logs** (~23 MB) were left untracked and are now
  gitignored. Regenerate them with the config above; nothing depends on the originals.
- **Session memory** (`~/.claude/projects/.../memory/`) is per-machine and does not
  sync. The durable cross-machine notes live in the git-synced
  `mwgrant21/agent-improvement` store, which is where the `pr-review-watch` loop state
  and the extracted lessons are.
- One lesson worth carrying across without reading that store: **a Windows CI runner's
  temp directory is an 8.3 short path** (`RUNNER~1`) that `realpath` expands, so a
  test comparing path *string prefixes* passes locally and fails there. Compare
  resolved `dirname`s instead.
