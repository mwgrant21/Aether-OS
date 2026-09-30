# Handoff: #22 white-screen diagnostics (2026-09-29)

Written on the work machine (`work-it`) to pick up on the home machine. It lives on the branch
`fix/22-diag-log`, which is pushed; it is **not merged and has no PR yet**.

## Pick up at home

```
git fetch origin
git switch fix/22-diag-log          # tracks origin/fix/22-diag-log
npm ci
npm test                            # last run on work-it: 202 files passed / 1 skipped, 2247 passed / 14 skipped, 0 failed
npm run typecheck:electron && npm run build
```

Next: open the PR against `master` (title suggestion: "#22: persist [diag] lines to diag.log and probe the renderer after unlock/resume"). Say in the body that it **does not fix #22**. It collects evidence, and #22 stays open. Codex will auto-review. Clear every thread before merging (BLOCKED with green CI means an unresolved thread). It squash-merges, so the red intermediate commit (see "Branch notes") does not matter.

After it merges: bump the version per `docs/packaging.md` → Versioning, run `npm run dist`, install, and **use the app normally**. The logging only helps in the installed build.

## Why this exists

#22: after a Windows lock, the renderer stays alive but paints white. PR #45 added `[diag]` handlers in the main process, but they only used `console.error`. The installed app has no console, so a recurrence captured nothing. DevTools cannot help either: `Menu.setApplicationMenu(null)` removes Ctrl+Shift+I in the packaged app, and opening DevTools forces a relayout that can "heal" a paint failure and destroy the evidence.

**Discriminator: keep it intact.** `global.css` paints the body `#020a10`, while `BrowserWindow` sets **no** `backgroundColor` (native default white).
- **White window + intact DOM:** compositor/GPU paint failure (the leading hypothesis).
- **Dark empty window + console errors:** a React/JS failure (there is no error boundary anywhere).
- **Probe timed out:** the renderer's main thread is stuck.

**Do not add a window `backgroundColor`** until #22 is diagnosed. It would turn the telling white into an ambiguous dark.

## What the branch ships

- **`electron/diagLog.ts`:** every `[diag]` line goes to `console.error` AND is appended synchronously to `~/.aether-os/diag.log`. At 1 MB it rotates to `diag.log.1`, replacing any old one, so the total stays at about 2 MB. fs errors never throw and are reported once. If the rotation fails (for example `diag.log.1` is held open), the append still happens.
- **Start banner:** `[diag] start version= electron= chrome= packaged= at=` separates runs. It is skipped on the statusline-uninstall run.
- **`electron/rendererProbe.ts`:** 2 s after `unlock-screen`/`resume` it writes one line:
  `[diag] probe reason= win= root= bodyBg= vis= canvases= glLost= size=WxH white=n/5 at=`
  (a DOM probe via executeJavaScript, and 5 pixels sampled via capturePage, each with a 3 s timeout, never throwing, and never calling getContext).
- **Renderer console errors** are forwarded as `[diag] renderer-console level=error src=<basename>:<line> msg=<≤300 chars> at=`, at most 20 per 60 s. The suppressed count is reported only when a later error is admitted; that is accepted and noted in a code comment.
- **`glShader.ts`:** `webglcontextlost` sets `data-gl-lost` and logs `[diag] webgl context lost` (which is forwarded). `restored` clears the flag. Diagnosis only: no preventDefault, no recovery.
- **Test hook:** `AETHER_DIAG_PROBE_ON_START=1` runs the probe 5 s after load (off by default).
- **`docs/privacy-and-data.md` §7:** diag.log contents documented. The URL is "the app's own page in practice", because there is no will-navigate guard.

**Healthy baseline**, observed in a live launch of the built app (real GPU, isolated profile):
`[diag] probe reason=start win=visible root=1 bodyBg=rgb(2,10,16) vis=visible canvases=1 glLost=0 size=1752x1128 white=0/5`

## Reading diag.log after a recurrence

Open `~/.aether-os/diag.log` (and `.1`) **before** doing anything to the white window, and find the `unlock-screen`/`resume` line nearest the incident:

| Probe after unlock | Meaning | Next step |
|---|---|---|
| `root>=1 bodyBg=rgb(2,10,16) white=5/5`, often with a GPU `child-process-gone` or `glLost>=1` nearby | Paint/compositor failure, with the DOM fine | Renderer GPU context-loss recovery (for example, reload the webContents on GPU child death or a white probe) |
| `root=0` and/or `renderer-console` errors | JS/React failure | An error boundary, and fix the thrown error |
| `root=timeout` | Renderer main thread stuck | Find what blocks on resume |
| No probe line after the unlock | The trigger or window is missing | Check the powerMonitor wiring and whether the window was hidden or minimized |

## Review trail

- Task 1 (diagLog) and task 2 (probe) were built by one builder, reviewed cold by a fresh reviewer, and got **REWORK** (the renderer-console line had no timestamp) plus 4 nits. All were fixed in rework round 1.
- Round 1 review: **ACCEPT** (a fresh reviewer, independent of the first). It reproduced the red-proof of the rename-failure test on scratch copies (the squatting directory really makes renameSync throw, and on POSIX too, via EISDIR). 2247 passed / 14 skipped; typecheck clean. Its two wording nits (the garbled privacy-doc sentence, a stray blank line) were fixed in the handoff commit. Parser note: renderer-console `msg=` is free text before ` at=`, so split on the LAST ` at=`.
- Verified independently by the reviewer: the full suite, typecheck, `build`, `electron:build`, the live probe line above, the BGRA channel order (measured), the Electron 43 `console-message` event signature (electron.d.ts), and that e2e/launchApp cannot write to the real `~/.aether-os`.
- **Not exercised:** a real lock/unlock or suspend/resume trigger. The start hook stands in for it. The first real lock at home is the first real test: lock, unlock, then check diag.log for a `probe reason=unlock-screen` line.

## Branch notes

- Commits on `6499bf8`: `109b7e9` diagLog, `4e60811` test pin, `a796875` probe, `ea88499` suppressed-line timestamp, then the rework commit `78228c4` and `01fd809`, and finally this handoff commit. **The rework commit alone has a failing test** (an fs mock that never took effect), and `01fd809` replaces it with a directory squatting on `diag.log.1`. That is fine under squash merge; don't bisect across it.
- `launchApp()` in `e2e/electronHelpers.ts` whitelists env vars, so it cannot pass `AETHER_DIAG_PROBE_ON_START`. The live checks used a temporary copy. Consider adding an `env` option to launchApp as a small follow-up.

## Open follow-ups (not in this branch)

- Add diag.log to Settings → Purge.
- Add a will-navigate / setWindowOpenHandler guard (hardening, which would also make the privacy-doc URL claim unconditional).
- The `electron-winstaller` install script is not in npm's allowScripts yet (`npm approve-scripts electron-winstaller`). It only matters for `npm run dist`.
- The carry-overs from the 2026-09-29 idle-composition handoff are still open (the critique polish list, fmtEta "n/a", the NaN burn guard, Settings aria-pressed).
- Collector issues #65, #67, #69, #71, #72, #73.
