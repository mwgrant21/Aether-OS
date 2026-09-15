# Cross-check Task 5A — variable prompt layout

Implemented against `723cd40`. This checkpoint changes prompt structure recognition only; CSI 8 resize handling remains Task 5B.

## Result

The matcher now requires seven ordered, blank-separated regions instead of fixed row offsets: workspace header, nonempty workspace path, complete safety paragraph, capability warning, security guide, both options, and confirmation. Supported path/paragraph wrapping stays within those regions. Interleaved or trailing content rejects recognition. Existing bounded screen, parser uncertainty, synchronized output, ownership integration, and public API remain unchanged.

Added a sanitized extraction of the first real long-path frame. It preserves the continuation row and control positions; original PTY callback boundaries were not retained by the source log, so the fixture documents its one-chunk extraction. Tests additionally cover every split of that frame, stale/complete redraw, independently generated 64- and 92-column text layouts, and addressed unrelated fragments.

## Evidence

- **Passed:** independent replay of the actual saved 1,079-character first frame: base matcher `{seenAt:null, active:false}`; revised matcher `{seenAt:1000, active:true}`.
- **Passed:** final corrected fixture matches the extracted frame exactly after equal-width username/suffix sanitization. It retains 87 CSI controls and 12 absolute cursor addresses.
- **Passed:** 47 focused matcher tests after fixture correction; Electron typecheck.
- **Passed:** full unit suite — 1,819 passed, 7 skipped across 164 passed test files and one skipped file. This ran before the final fixture-only correction; unchanged matcher code passed it, and the corrected fixture subsequently passed all 47 focused tests.
- **Passed:** renderer and Electron builds. The existing renderer chunk-size advisory remains; no build error. Fixture-only correction did not alter production build inputs.
- **Passed:** whitespace check. Git reports its existing LF/CRLF conversion advisories.
- **Passed:** independent spec and code-quality review after the fixture correction; no remaining findings.

Independent review found one evidence defect: the first fixture version changed a six-character suffix to seven zeros. That altered row width and made its provenance claim incorrect even though recognition passed. The correction restores six zeros and explicitly retracts the earlier 1,080-character equality claim. Matcher code required no review correction.

## Limits and next step

**Incomplete:** a fresh real-client launch displaying corrected recognition, default-installed Claude 2.1.270 compatibility, supported native resize/redraw recovery (5B), the previously unisolated Task 5 ConPTY replay failure, and remaining U9 gates. Offline replay of real bytes does not close these checks. No new client launch, trust response, or model request occurred.

Next: Task 5B, then Task 6A–6C. No push or merge.

Evidence logs in this chat's `work/`: `task5a-implement.md`, `task5a-review.md`, `task5a-raw-replay.json`, `task5a-tests.txt`, `task5a-build.txt`, and `task5a-electron-build.txt`.
