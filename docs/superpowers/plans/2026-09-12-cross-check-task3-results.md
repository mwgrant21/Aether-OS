# Cross-check Task 3: bounded current-prompt recognition

Date: 2026-09-12. Base: `2e234ea`, branch `feat/visible-communication-u1`.

## Result

**Passed:** isolated Task 3 matcher, fixture preparation, and verification. No terminal wiring, selected-option parsing, automatic input, or model request was added.

`createTrustPromptMatcher(now?, dimensions?)` incrementally interprets a bounded subset of terminal output and recognizes the full captured folder-trust layout. It exposes only `{ seenAt, active }`, plus ingest, resize, and fresh-session reset operations. `seenAt` is historical evidence, not proof of readiness or exit. The matcher may recognize a complete redraw again after current evidence clears.

The parser retains at most a 32-row by 160-column screen and a 512-character control buffer. Default geometry is 100 columns by 30 rows. CSI positioning/erasure, split OSC BEL/ST terminators, hidden hyperlink metadata, control cancellation, conceal, synchronized output, and pending right-margin wrapping are covered. Unknown persistent modes prevent recognition until a fresh-session reset. Unsupported geometry/glyphs/scroll behavior produce no positive current evidence.

## Departures from the draft

The companion plan's append-only two-option matcher was rejected: quoted labels, screen erasure, redraw, and arbitrary chunk splits invalidate its assumptions. Silence is not evidence of current prompt presence, and printable output need not mean the operator answered. A bounded screen model replaces that sample; the shared whole-string `ansiStrip` helper remains unchanged.

Independent review found OSC cancellation could hide subsequent overwrites, concealed text could count as visible, and persistent modes could survive an erase. The correction introduced explicit conservative parser/mode handling. Geometry then exposed the capture's exactly-full separator row; pending wrap now distinguishes a valid last-column write from an unsupported actual wrap. All fixes were rechecked with positive capture controls and negative cases before acceptance.

## Verification

| Check | Verdict | Evidence |
| --- | --- | --- |
| Full unit suite | Passed | 1,774 tests, 7 skipped; 162 files passed, 1 skipped |
| New matcher suite | Passed | 42 tests, included in the full suite |
| Renderer build/typecheck | Passed | `npm run build`, exit 0 |
| Electron typecheck | Passed | `npm run typecheck:electron`, exit 0 |
| Independent final review | Passed | 42/42 focused tests and 13 additional adversarial probes; no remaining material finding within the supported subset |
| Fixture sanitization | Passed | All eight timestamps/chunks and control bytes preserved except equal-length user/temp-path substitutions |

Tests include all two-part split points and one-character delivery of the capture, plain quoted/log negatives, hidden OSC prompt text, clear-only invalidation, repaint/reactivation, cursor overwrite, malformed/oversized controls, synchronization, geometry/resize, reset, and unchanged history semantics. A negative control demonstrates why the rejected two-label baseline accepts misleading log text.

The capture now uses neutral username/temp placeholders and records its sanitization. It is not an untouched recording; the original path remains in git history, which was not rewritten. Its timeout is only the capture terminus.

## Limits and Task 4 contract

**Incomplete:** no fresh native prompt capture or live detector integration was exercised. This is a tested, bounded recognizer, not a general terminal emulator or authentication mechanism. A process can paint an identical prompt. Different layouts, locales, Unicode widths, unsupported geometry, wrapping, or terminal modes can yield false negatives; do not turn those into positive trust/readiness claims.

Task 4 must provide the actual PTY dimensions, call `resize(cols, rows)` before feeding output under changed dimensions, preserve sticky mode uncertainty across resize, and reserve `reset()` for a fresh physical terminal session. Clearing the viewport does not reset terminal modes. It must also retain the launch/PTY callback ownership protections from Tasks 1–2. No renderer IPC should accept raw observations or credentials.

U9's production/live verification gates are not closed by this work. Next: Task 4's lifecycle-aware detector wiring.

## Evidence and reference

Chat workspace `work/`: `cross-check-t3-tests.txt`, `cross-check-t3-build.txt`, `cross-check-t3-types.txt`, and `cross-check-task3-review-checkpoint.md`. The earlier focused log has 41 tests; the final full-suite and independent-review counts include the added right-margin test, totaling 42.

The distinction between viewport erase (CSI 2J) and scrollback erase (CSI 3J) was verified against [xterm.js supported terminal sequences](https://xtermjs.org/docs/api/vtfeatures/). Cancellation and rendering-mode behavior was checked against the installed xterm parser/InputHandler source during independent review.
