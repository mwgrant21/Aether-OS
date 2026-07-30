# Go Collector Hardening (Stage 10 follow-up) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Minor/Important findings the Stage 10 final whole-branch review deferred as
named follow-up work (not merge-blocking), now that PR #5 (`go-collector-stage10`) is open. Every
finding below has an exact fix already specified by that review — this plan has no open design
questions, only implementation. No design spec accompanies this plan; the review itself (quoted
per-finding below) is the requirements source.

**Context:** `docs/superpowers/plans/2026-07-30-go-collector-stage10.md` shipped the Go collector
port. Its final whole-branch review found no Critical issues and three merge-blocking Important
items (already fixed in that PR: CI coverage, README, gofmt/CRLF). Everything below was explicitly
scoped by that review as safe to ship deferred — this plan closes that list out.

**Base branch:** `go-collector-stage10` (this branch stacks on it, not on `master` — `collector-go/`
does not exist on `master` yet). PR review target: `go-collector-stage10`.

## Global Constraints

- **Go is at `C:\Program Files\Go\bin`, not on PATH in fresh shells.** Every Bash command in every
  task must be prefixed with `export PATH="/c/Program Files/Go/bin:$PATH"`.
- No feature changes, no schema changes, no behavior changes beyond what each fix specifies —
  every fix here corrects a divergence FROM the TS source of truth (`collector/src/`), not a new
  behavior. Read the cited TS file for any fix where exact semantics matter.
- Do not touch anything under `collector/` (the Node package) — read-only reference.
- Run `go build ./...` and `go vet ./...` in `collector-go/` after every task; run the FULL
  `go test ./...` (not just the task's own package) before every task's commit.
- This repo's `.gitattributes` (`*.go text eol=lf`) already exists — new/edited files should come
  out LF-normalized via `gofmt -w` automatically; do not fight it.

---

### Task 1: hookinstall write-path fidelity (array-shaped `hooks`, JSON escaping, unrelated-key coverage)

**Files:**
- Modify: `collector-go/internal/hookinstall/installer.go`
- Modify: `collector-go/internal/hookinstall/installer_test.go`

**Findings addressed (from the Stage 10 final review):**

> **Minor #6** — `installer.go` install path (`installGroup`): when a settings.json's top-level
> `hooks` value is a JSON **array** rather than an object, TS's `typeof parsed.hooks === 'object'`
> check (true for arrays — a JS quirk) lets it through to `{...(parsed.hooks as
> Record<string, unknown>)}`, which spreads the array's elements into a plain object with
> numeric-string keys (`{"0": ..., "1": ...}`) and preserves them. The Go port's
> `result.parsed["hooks"].(map[string]interface{})` type assertion fails silently on an array,
> so `hooks` starts empty and **the array is discarded entirely** — real data loss where TS keeps
> it. Confirmed in `collector/src/hookInstaller.ts:103,141,178,230` — all four hooks-normalization
> call sites (install×2 event-group functions sharing one body, uninstall×2 same) use this same
> `typeof === 'object' ? {...value} : {}` pattern. The Go uninstall path (`uninstallByMarker`) has
> the mirror bug: `result.parsed["hooks"].(map[string]interface{})` failing on an array causes an
> early return-as-no-op (`ok: true, no backup, no write`) where TS proceeds to spread-and-write.
>
> Real-world risk is negligible — actual Claude Code `settings.json` never has array-shaped
> top-level `hooks` — but the fix is small and closes a genuine data-loss path.

> **Minor #7/#10** — `json.MarshalIndent` (Go's `encoding/json`) HTML-escapes `<`, `>`, `&` in
> every string value by default; `JSON.stringify` does not. Every hook-install/uninstall write
> therefore rewrites *unrelated* hook groups' command strings — e.g. `powershell -File x.ps1 >
> log.txt` becomes `powershell -File x.ps1 \u003e log.txt`. Round-trips to an identical string on
> read, so nothing breaks, but a user diffing their own `settings.json` sees noise they didn't
> cause, and the package doc comment's claim that unrelated content is preserved "byte-for-byte in
> VALUE" is only true after a JSON parse. Fix: use a `json.Encoder` with `SetEscapeHTML(false)`
> instead of `json.MarshalIndent`. Note `Encoder.Encode` appends a trailing newline that
> `MarshalIndent` doesn't — trim it to keep the current output shape unchanged.

> **Minor (parked from Task 7)** — no fixture test asserts an unrelated **non-`hooks` top-level
> key** in settings.json survives a merge byte-identical. Code is correct by inspection (`for k, v
> := range result.parsed { merged[k] = v }` copies every key forward) but untested by either the TS
> suite or the Go port. Add one.

**Steps:**

- [ ] **Step 1: Read the current code and the TS source of truth**

Read `installer.go` in full (already read once this session — `installGroup` around line 185-253,
`uninstallByMarker` around line 328-384). Read `collector/src/hookInstaller.ts:95-145` (install) and
`:165-235` (uninstall) for the exact `typeof === 'object' ? {...value} : {}` normalization pattern
this task ports.

- [ ] **Step 2: Write failing tests**

In `installer_test.go`, add:
- A fixture where `settings.json`'s top-level `hooks` value is a JSON array (e.g.
  `"hooks": ["legacy-entry-1", "legacy-entry-2"]` or similar plausible-but-wrong shape). Assert
  install produces a written file whose `hooks` key is now an object with `"0"`/`"1"` keys holding
  the original array elements, PLUS the newly-installed event groups — i.e. nothing from the
  original array is lost. Assert the same for uninstall (starting from an array-shaped `hooks`,
  the write happens — not a no-op — and the array elements survive under numeric keys, since none
  of them will match any of `ManagedHookEvents`/`permissionHookEvents`'s marker-based removal).
- A fixture with an unrelated hook command containing `&&` and `>` (e.g.
  `"command": "powershell -File x.ps1 && echo done > log.txt"`) in a pre-existing unrelated hook
  group (same style as the existing `TestInstallHooks_PreservesExistingUnrelatedHookEntryForManagedEvent`
  fixture). After install, read the written file's raw bytes and assert the literal substrings
  `&&` and `>` appear unescaped (not `\u0026\u0026`/`\u003e`).
- A fixture with an unrelated top-level key outside `hooks` entirely (e.g. `"model": "sonnet"` or
  a `"permissions"` object) alongside a pre-existing hooks setup. After both install and uninstall,
  assert that key's value is present and byte-identical (not just structurally equal) in the
  written file.

- [ ] **Step 3: Run tests to verify they fail**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/IT/Desktop/Aether-OS/.worktrees/go-collector-hardening/collector-go
go test ./internal/hookinstall/...
```

- [ ] **Step 4: Implement**

Add a helper (e.g. `normalizeHooksValue(v interface{}) map[string]interface{}`) that: returns a
copy of `v` if it's already `map[string]interface{}`; converts `v` to a map with string-index keys
(`"0"`, `"1"`, ...) if it's `[]interface{}`, matching JS's `{...array}` spread; returns `{}`
otherwise (nil, wrong type, absent key). Use it in place of the current failing type-assertions in
both `installGroup` (replacing line ~201's `if hobj, ok := ...` block) and `uninstallByMarker`
(replacing line ~336's `hooksObj, isObj := ...; if !isObj { return early }` — this early-return
must go away for the array case, matching TS's continue-and-write behavior; only a truly absent or
`nil` `hooks` key should still skip the write, matching TS's `!fileExisted ||
typeof parsed.hooks !== 'object' || parsed.hooks === null` early-return guard exactly).

For the JSON-escaping fix: add a small helper (e.g. `marshalSettingsJSON(v interface{}) ([]byte,
error)`) using `bytes.Buffer` + `json.NewEncoder(&buf)` with `SetEscapeHTML(false)` and
`SetIndent("", "  ")`, trimming the trailing `\n` the encoder appends. Replace both
`json.MarshalIndent(merged, "", "  ")` call sites with this helper.

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/IT/Desktop/Aether-OS/.worktrees/go-collector-hardening/collector-go
go test ./... -v
go build ./...
go vet ./...
```

- [ ] **Step 6: Commit**

```bash
git add collector-go/
git commit -m "fix(collector-go): preserve array-shaped top-level hooks, stop HTML-escaping settings.json writes"
```

---

### Task 2: spool tailer's `stop()` joins its own goroutine

**Files:**
- Modify: `collector-go/internal/spool/tailer.go`
- Modify: `collector-go/internal/spool/tailer_test.go` (create if it doesn't already cover
  `StartSpoolTailer` directly — check first)

**Finding addressed:**

> **Minor #8** — `StartSpoolTailer`'s returned `stop()` only closes its internal `done` channel; it
> does not wait for the goroutine to actually exit before returning. Since Go's `select` picks
> randomly when both `ticker.C` and `done` are simultaneously ready, a `TailSpoolOnce` pass can
> start running *after* `stop()` (and, in the collector's real usage, the subsequent `db.Close()`)
> has already been called. In that window, `ingestLine` returns `false` on the closed DB, but
> `tailer.go`'s `os.Remove(filePath)` runs **unconditionally** regardless of ingest success — a
> spool file gets deleted without being ingested. The TS original cannot hit this: `clearInterval`
> is synchronous on Node's single-threaded runtime, so this is a failure mode the Go port
> introduces, not one it inherits. The window is tiny and `cmd/aether-collector` calls `os.Exit(0)`
> immediately after `stop()` today, so this has been low-impact in practice — but it should close
> before any cutover decision.

**Steps:**

- [ ] **Step 1: Read the current code**

Read `collector-go/internal/spool/tailer.go` in full (already read this session — `StartSpoolTailer`
at line 65-84). Read `collector-go/internal/collector/collector.go`'s `startTickerLoop` (line
93-113) for the sibling pattern this fix should match: a `*sync.WaitGroup` the goroutine
`wg.Add(1)`s before starting and `defer wg.Done()`s inside, joined by the caller via `wg.Wait()`.

- [ ] **Step 2: Write a failing test**

Add a test that starts a tailer with a very short interval against a temp spool dir, calls `stop()`,
and immediately asserts (via a counter or a channel the goroutine signals right before it would
return) that the goroutine has actually exited — not just that `done` was closed. A workable
approach: have the goroutine send on an unbuffered `chan struct{}` right before `return` inside a
test-only wrapper, or — simpler and sufficient — assert that after `stop()` returns, a `WaitGroup`
the test itself doesn't have access to has synced by relying on `StartSpoolTailer`'s own new
internal contract: call `stop()` N times in a tight loop from N goroutines (a `stop()` that doesn't
block could let two calls race processing `TailSpoolOnce` past return) — or, most directly, prove
the promised contract by having the test replace `TailSpoolOnce`'s effect with something observable
(e.g. write a spool file, call `stop()`, and assert no further file-deletion happens by checking the
tailer never runs after `stop()` returns, using a `sync/atomic` counter incremented inside a
version of the loop you can inject for the test — use your judgment on the cleanest way to prove
"stop() does not return until the goroutine has exited" without over-engineering the test). If
after investigating you find a simpler, more idiomatic way to prove this than what's sketched here,
use it — the requirement is the proof, not this specific mechanism.

- [ ] **Step 3: Run the test to verify it fails**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/IT/Desktop/Aether-OS/.worktrees/go-collector-hardening/collector-go
go test ./internal/spool/... -run TestStartSpoolTailer
```

- [ ] **Step 4: Implement**

Add a `sync.WaitGroup` inside `StartSpoolTailer`: `wg.Add(1)` before `go func() {...}()`,
`defer wg.Done()` as the first line inside the goroutine, and change the returned `stop` closure
from `func() { close(done) }` to `func() { close(done); wg.Wait() }`. This is a purely internal
change — `StartSpoolTailer`'s exported signature is unchanged, so `internal/collector/collector.go`'s
existing `stopTailer := spool.StartSpoolTailer(...)` call site needs no edit; its `stop = func() {
stopTailer(); close(done); wg.Wait(); db.Close() }` (collector.go line ~206-211) now correctly waits
for the tailer goroutine before proceeding to `db.Close()`, closing the race for real.

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/IT/Desktop/Aether-OS/.worktrees/go-collector-hardening/collector-go
go test ./... -v
go build ./...
go vet ./...
```

- [ ] **Step 6: Commit**

```bash
git add collector-go/
git commit -m "fix(collector-go): spool tailer's stop() now waits for its goroutine to exit"
```

---

### Task 3: transcript path-privacy edge cases (Windows POSIX-style absolute paths, case-insensitive volumes)

**Files:**
- Modify: `collector-go/internal/transcript/toolcallhistory.go`
- Modify: `collector-go/internal/transcript/toolcallhistory_test.go`

**Findings addressed:**

> **Minor #4** — `ToProjectRelative`'s `filepath.IsAbs` diverges from Node's `path.isAbsolute` on
> Windows for POSIX-style paths. Node's win32 `isAbsolute` returns `true` for any path whose first
> character is `/` or `\` (confirmed directly against Node's `path.js` source: `isPathSeparator`
> check on the first character short-circuits to `true` regardless of what follows — no drive
> letter needed). Go's `filepath.IsAbs` on Windows requires a real volume prefix (drive letter +
> colon, or a `\\server\share` UNC prefix) and returns `false` for a bare `/home/matt/secret.ts`.
> Consequence: TS treats such a path as absolute, computes a nonsense `relative()` against the
> Windows project root, and `hasTraversalSegment` catches the resulting `..`-laden garbage and
> drops it (`null`). Go's port treats it as *already relative*, skips the `Rel` computation
> entirely, finds no `..` segments, and **passes the raw absolute path through into
> `tool_calls.file_path_rel` and any anomaly `detail` string that includes it** — the one guard
> `docs/privacy-and-data.md` names paths as needing, in the direction that actually leaks.
>
> Exposure is low in practice (Claude Code on Windows emits native `C:\...` paths, and `file_path`
> only ever comes from Read/Write/Edit tool inputs), which is why this was Minor, not Important —
> but it's a real gap in the one guard that exists.

> **Minor #5** — `filepath.Rel` is case-sensitive on volume/drive-letter comparison; Node's win32
> `path.relative` is case-insensitive. If a transcript's `cwd` is `C:\projects\x` and a `file_path`
> is `c:\projects\x\src\a.ts` (lowercase drive letter — can happen from certain tool
> outputs/shells), Node relativizes to `src\a.ts`; Go's `Rel` errors on what it sees as a
> volume-name mismatch, and the path is dropped (`file_path_rel` ends up `nil`). This fails *safe*
> (drops rather than leaks) so it's lower priority than #4, but it's a real, avoidable coverage
> gap — a legitimate relative path silently becomes unavailable to the anomaly detectors/UI that
> use `file_path_rel`.

**Steps:**

- [ ] **Step 1: Read the current code and TS source of truth**

Read `collector-go/internal/transcript/toolcallhistory.go`'s `ToProjectRelative` (already read this
session — lines 60-97) and `collector/src/toolCallHistory.ts`'s `toProjectRelative` (the function
this ports) plus its test file, focusing on how the TS version's `path.isAbsolute`/`path.relative`
behave on the two edge cases above.

- [ ] **Step 2: Write failing tests**

Add test cases to `toolcallhistory_test.go`:
- `ToProjectRelative` given a POSIX-style path (`/home/matt/secret.ts`) and a Windows-style project
  root (`C:\projects\x`) returns `nil` (matches TS's traversal-guard-catches-it outcome), NOT the
  raw path passed through.
- `ToProjectRelative` given `cwd`/project root `C:\projects\x` and a file path
  `c:\projects\x\src\a.ts` (lowercase drive letter, otherwise identical) returns `"src\\a.ts"` (or
  the OS-appropriate separator), matching what it would return for an exact-case match — not `nil`.
- Keep the existing cross-drive-Windows-only test (`TestToProjectRelative_CrossDriveWindowsOnly` or
  similarly named, per the earlier review's mention of it) passing unmodified — this task must not
  regress the already-correct cross-drive-rejection behavior, only add coverage for the two new
  edge cases above.

- [ ] **Step 3: Run tests to verify they fail**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/IT/Desktop/Aether-OS/.worktrees/go-collector-hardening/collector-go
go test ./internal/transcript/... -run TestToProjectRelative
```

- [ ] **Step 4: Implement**

For #4: add a helper (e.g. `isAbsoluteLikeNode(p string) bool`) that returns `true` if
`filepath.IsAbs(p)` is true, OR if `len(p) > 0` and the first byte is `/` or `\` — matching Node's
win32 `isAbsolute` exactly (leading separator alone is sufficient, no drive letter required). Use
this in place of the current `if !filepath.IsAbs(fp)` check at the top of `ToProjectRelative`. Note
that `filepath.Rel` will very likely return an error for a POSIX-style `fp` against a
volume-qualified `projectRoot` (no matching volume name) — that's fine, the existing `if err != nil
{ return nil }` branch already handles it correctly; the fix is only about routing such paths into
the `Rel`-and-guard branch instead of skipping it.

For #5: before calling `filepath.Rel(*projectRoot, fp)`, add a case-insensitive volume-prefix
normalization: extract each path's volume name via `filepath.VolumeName`, and if both are
non-empty and equal under `strings.EqualFold` but not under `==`, rewrite `fp`'s volume-name prefix
to match `*projectRoot`'s exact casing before calling `Rel` (e.g. `fp = projectRootVolume +
fp[len(fpVolume):]`). This is a targeted fix for the common single-drive-different-case case, not a
full reimplementation of win32 `path.relative`'s normalization — that scope is appropriate per the
review's own "note rather than a defect" framing.

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/IT/Desktop/Aether-OS/.worktrees/go-collector-hardening/collector-go
go test ./... -v
go build ./...
go vet ./...
```

- [ ] **Step 6: Commit**

```bash
git add collector-go/
git commit -m "fix(collector-go): match Node's win32 path semantics for POSIX-style and case-varied paths"
```

---

### Task 4: `parser.go`'s `stringifiedLength` JSON-escaping consistency

**Files:**
- Modify: `collector-go/internal/transcript/parser.go`
- Modify: `collector-go/internal/transcript/parser_test.go`

**Finding addressed:**

> **Minor #10** — `stringifiedLength` (in `parser.go`) uses `json.Marshal`, which inherits the same
> HTML-escaping Task 1 fixes in `hookinstall`: `JSON.stringify("a > b")` is 9 bytes;
> `json.Marshal("a > b")` produces 13 (`\u003e`). The field this feeds (`ResultLength`) is
> currently never persisted or thresholded anywhere in the codebase, so there is no live behavioral
> impact today — but it's a silent divergence sitting in a field named after a length, and fixing
> it is a one-line change now that Task 1 has already built the no-escape encoding pattern.

**Steps:**

- [ ] **Step 1: Read the current code**

Read `parser.go`'s `stringifiedLength` function and its test coverage. Confirm the review's claim
that `ResultLength` is unused elsewhere (grep the `collector-go` tree for `ResultLength` to verify
before touching anything — if it turns out to be used somewhere this task's context doesn't know
about, treat that as new information and adjust: a used field needs the fix to preserve current
callers' expectations, not just cosmetic parity).

- [ ] **Step 2: Write a failing test**

Add a test asserting `stringifiedLength` on a value containing `<`, `>`, or `&` in a string field
returns the same byte length `JSON.stringify` would (i.e. the unescaped length), not the
HTML-escaped one.

- [ ] **Step 3: Run the test to verify it fails**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/IT/Desktop/Aether-OS/.worktrees/go-collector-hardening/collector-go
go test ./internal/transcript/... -run TestStringifiedLength
```

- [ ] **Step 4: Implement**

Replace `json.Marshal` in `stringifiedLength` with the same escape-disabled encoding approach Task
1 introduced for `hookinstall` (a `bytes.Buffer` + `json.NewEncoder` with `SetEscapeHTML(false)`,
trimming the trailing newline before taking `len(...)`) — or, if it's cleaner given this function
only needs a length and not the bytes themselves, any equivalent escape-disabled length
computation. Keep it minimal; this function doesn't need `hookinstall`'s indent formatting.

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/IT/Desktop/Aether-OS/.worktrees/go-collector-hardening/collector-go
go test ./... -v
go build ./...
go vet ./...
```

- [ ] **Step 6: Commit**

```bash
git add collector-go/
git commit -m "fix(collector-go): stringifiedLength no longer inflates length via JSON HTML-escaping"
```

---

### Task 5: low-priority cleanup (double JSON-parse, dead-code doc comment, CLI arg-parsing consistency)

**Files:**
- Modify: `collector-go/internal/spool/ingest.go`, `collector-go/internal/spool/payload.go`
- Modify: `collector-go/internal/hookinstall/installer.go` (doc comment only)
- Modify: `collector-go/cmd/aether-collector-cli/main.go`
- Modify matching `_test.go` files as needed for the ingest.go/payload.go behavioral change

This task bundles three small, independent, low-priority findings — none depends on another and
each is too small to be its own task, mirroring the Stage 10 plan's own precedent (Task 7) for
bundling small independent items. If any one of these turns out subtler than expected once you've
read the code, split it into its own follow-up and say so in your report rather than forcing it in.

**Findings addressed:**

> **Minor #11** — `spool/ingest.go`'s `ingestLine` unmarshals the spool line into `raw` for the
> canary drift-check, then `ParseHookPayload(trimmed)` unmarshals the same bytes again. TS parses
> once (`ingest.ts:37`: `parseHookPayload(parsed, receivedAtMs)` — passes the already-parsed
> object). Behaviorally identical either way; ~2x the parse cost on the collector's hottest path.
> Fix: an unexported `parseHookPayloadFromObj(map[string]interface{}) (*HookEvent, error)` (or
> similarly named) that `ParseHookPayload` itself calls after its own unmarshal, and that
> `ingestLine` calls directly with the already-parsed `raw` map — closing the double-parse without
> changing `ParseHookPayload`'s existing exported signature/behavior for its other callers.

> **Minor #12** — `hookinstall.InstallPermissionHooks`/`UninstallPermissionHooks` are exported but
> unreachable from either Go binary (`cmd/aether-collector` or `cmd/aether-collector-cli`) — their
> only real consumer in the TS original is the Electron app, which is out of scope for this port.
> The port is faithful; the functions just read as unexplained dead code to someone who doesn't
> know that. Fix: add one sentence to each function's doc comment (or a package-level note) stating
> plainly that these are ported for parity/future use and are not currently called by either Go
> binary — no code change, documentation only.

> **Minor #13** — `cmd/aether-collector-cli/main.go`'s command-verb parsing is a small hand-rolled
> loop reading `os.Args[1]` as a bare positional, while `cmd/aether-collector/main.go` uses the
> standard `flag` package — a stylistic inconsistency between the two binaries, not a bug (the
> hand-rolled loop is correct). Separately, `install-autostart` produces a scheduled-task command
> line of `/TR "<exe>" ""` — a stray trailing empty argument that `flag.Parse()` on the *target*
> binary silently ignores (harmless) but that will read as a mistake to a future person inspecting
> the registered task. Fix the `/TR` argument only (not the arg-parsing style inconsistency, which
> is genuinely just style and not worth the disruption of rewriting a working, tested CLI's parsing
> — name this decision in your report rather than silently doing a larger rewrite): find where the
> autostart command line is built (`internal/autostart`'s `BuildScheduledTaskCommand` or equivalent,
> per the earlier review's citation) and give it a single-path form so `install-autostart` can pass
> just `"<exe>"` with no trailing empty string.

**Steps:**

- [ ] **Step 1: Read the current code for all three items**

Read `spool/ingest.go`'s `ingestLine` and `spool/payload.go`'s `ParseHookPayload` in full. Read
`hookinstall/installer.go`'s `InstallPermissionHooks`/`UninstallPermissionHooks`. Read
`cmd/aether-collector-cli/main.go`'s `install-autostart` handling and whatever function in
`internal/autostart` builds the scheduled-task command line (confirm its exact name/signature
before planning the fix — the earlier review referenced `BuildScheduledTaskCommand` but verify
against the actual current source, which may have shifted since that review ran).

- [ ] **Step 2: Write failing tests**

For the double-parse fix: a test isn't strictly needed for a pure performance refactor with no
behavior change, but add (or confirm existing coverage already proves) that `ingestLine`'s
observable behavior — which events get ingested, which get flagged as drift, on realistic and
malformed input — is unchanged after the refactor; if existing tests already fully cover this,
note that in your report instead of adding redundant ones.

For the `/TR` fix: add a test asserting the scheduled-task command line built for
`install-autostart`'s self-contained-binary case (no separate interpreter) is `/TR "<exe>"` with no
trailing empty-string argument, where a test previously existed (or should exist) proving the old
two-argument shape.

- [ ] **Step 3: Run tests to verify the `/TR` one fails pre-fix**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/IT/Desktop/Aether-OS/.worktrees/go-collector-hardening/collector-go
go test ./internal/autostart/... ./cmd/...
```

- [ ] **Step 4: Implement all three**

1. Add `parseHookPayloadFromObj` (or equivalent) to `payload.go`; refactor `ParseHookPayload` to
   parse-then-delegate to it; refactor `ingest.go`'s `ingestLine` to parse the raw JSON exactly
   once and pass the parsed map to both the drift-check and the new delegate function.
2. Add the one-sentence doc-comment clarification to `InstallPermissionHooks`/
   `UninstallPermissionHooks`.
3. Give `BuildScheduledTaskCommand` (or whatever the actual function is named) a way to build a
   single-path `/TR "<exe>"` command line when there's no separate interpreter path, and use it
   from `cmd/aether-collector-cli/main.go`'s `install-autostart` handling instead of passing `""`
   as a second argument.

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/IT/Desktop/Aether-OS/.worktrees/go-collector-hardening/collector-go
go test ./... -v
go build ./...
go vet ./...
```

- [ ] **Step 6: Commit**

```bash
git add collector-go/
git commit -m "chore(collector-go): parse spool lines once, document permission-hook dead code, clean up autostart /TR arg"
```

---

### Task 6: parity harness multi-tick coverage

**Files:**
- Modify: `collector-go/scripts/parity/run-parity.mjs` (and sibling scripts under
  `collector-go/scripts/parity/` as needed)
- Modify: `PROGRESS.md` (amend the Stage 10 entry's parity-coverage claim if this task changes what
  it can honestly say — see Step 5)

**Finding addressed:**

> **Important #3 (from the Stage 10 final review, explicitly named as a follow-up, not a
> Stage-10-PR blocker)** — the golden-file parity harness's `RUN_MS = 6000` against 15s
> transcript-scan and fleet-poll intervals means each collector performs exactly one scan and one
> poll. This leaves several timing-dependent behaviors with no cross-collector differential
> coverage (only their own 1:1-ported unit tests): anomaly dedup across ticks (the
> `INSERT OR IGNORE` + unique-index contract collapsing ~20 repeat detections into one row — never
> exercised past the first detection), incremental offset-resume rescan (`transcript_files.
> last_offset`'s "only ingest newly appended lines on the second call" behavior), and
> `fleet_sessions`' 30s stale-prune (needs two polls 30s apart). Separately, `hookinstall` and
> `autostart` (Task 7 of the original plan) have zero cross-collector parity coverage at all — no
> `settings.json` fixture is part of the harness's input set, even though `hookInstaller.ts` was
> the plan's own flagged highest-risk file.
>
> The review's suggested fix, with its own caveat: "bump `AETHER_PARITY_RUN_MS` to ~35000 so a
> second scan/poll tick lands... caveat: a longer window makes the per-poll drift-row count
> timing-sensitive, so it may need the drift rows counted rather than diffed." Alternative
> (acceptable per the review): "amend the PROGRESS bullet to state plainly that parity covers one
> scan tick and does not cover retention, hook installation, or autostart" — i.e. honest-scoping is
> also a valid resolution if extending the harness proves too fragile to do cleanly.

**Steps:**

- [ ] **Step 1: Read the current harness**

Read `collector-go/scripts/parity/run-parity.mjs` in full (previously reported as ~213 lines) and
its sibling files under `scripts/parity/` (a reader-check script and any shared fixture-building
code were mentioned in the Task 9 report — read whatever's actually there). Understand exactly how
the current single-tick comparison works: what `RUN_MS` gates, how the fixture's spool/transcript
files are laid out, and how the two independent fixture copies (one per collector) are constructed.

- [ ] **Step 2: Decide the approach and justify it in your report**

Attempt the harness extension first: bump the run window long enough for a second transcript-scan
and fleet-poll tick to land in both collectors (the review suggests ~35000ms; verify against the
actual configured intervals in `collector-go/internal/collector`'s `Options` defaults and
`collector/src/index.ts`'s hardcoded values — use whatever multiple of the real interval is
sufficient, not a guessed number), and adjust the row-comparison logic for anomaly rows to count
rather than diff exact rows if the timing sensitivity the review warned about actually materializes
once you try it. Also extend the fixture to include a `settings.json` with realistic pre-existing
hook groups, and add hookinstall/autostart states to the parity comparison (run
`InstallHooks`/`UninstallHooks` equivalents — or whatever operations both collectors' CLIs actually
expose — against both fixture copies and diff the resulting `settings.json` files, excluding only
the already-known-and-accepted key-ordering and any genuinely time-stamped fields like a backup
filename's embedded timestamp).

If, after actually attempting this, the timing sensitivity or CI-runtime cost turns out
disproportionate to the value (name specifically why, with evidence — e.g. "the second tick
introduced N% flaky failures across M local runs" or "pushed harness runtime past N seconds"), the
fallback is honest-scoping: amend `PROGRESS.md`'s Stage 10 entry to state plainly, in the same
paragraph that currently claims row-for-row parity, that the parity run covers exactly one
scan/poll tick and does not cover multi-tick anomaly dedup, incremental rescan, fleet stale-prune,
or hookinstall/autostart. Either resolution is acceptable — choose based on what you actually find,
and say which you chose and why in your report.

- [ ] **Step 3: Run the extended (or documented) harness**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/IT/Desktop/Aether-OS/.worktrees/go-collector-hardening/collector-go
node scripts/parity/run-parity.mjs
```

Confirm it reports parity OK (or, if you chose the honest-scoping fallback, confirm the existing
single-tick harness still passes unmodified).

- [ ] **Step 4: Full verification**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/IT/Desktop/Aether-OS/.worktrees/go-collector-hardening/collector-go
go test ./... -v
go build ./...
go vet ./...
```

- [ ] **Step 5: Update `PROGRESS.md` if the coverage claim changed**

If you extended the harness to genuinely close the gap, no `PROGRESS.md` change is needed (the
existing claim becomes more true, not less). If you took the honest-scoping fallback for any part
of the gap, amend the relevant Stage 10 "Shipped plans" entry to accurately describe what parity
does and does not cover — do not leave a claim that reads as broader than what actually runs.

- [ ] **Step 6: Commit**

```bash
git add collector-go/ PROGRESS.md
git commit -m "test(collector-go): extend golden-file parity to multi-tick behaviors and hookinstall/autostart"
```
(Adjust the message if you took the honest-scoping fallback instead — e.g. `docs: scope Stage 10's
parity-coverage claim to what the harness actually runs`.)

---

## Closeout

After all 6 tasks are complete, individually reviewed, and a final whole-branch review is clean:
push this branch and open a PR against `go-collector-stage10` (not `master` — that branch's own PR
#5 is still open), following this repo's established PR conventions (see prior PRs' title/body
style, e.g. `gh pr view 3 --json body`).
