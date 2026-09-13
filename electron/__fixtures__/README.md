# Electron fixtures

`trust-prompt-capture.json` is the original sanitized eight-callback capture.

`trust-prompt-long-path-capture.json` is an offline extraction of the initial frame in
`work/untrusted-launch-R5Ri5a/terminal-output.txt`, ending at the first visible `cancel` in the
confirmation line. The extraction includes the CSI `1C` between `to` and `cancel`. The source log
may later contain appended session output; the original PTY callback boundaries cannot be recovered,
so the extracted frame is intentionally represented as one chunk. Its username and launch suffix
were replaced with equal-width placeholders (`Matt` to `User`, `R5Ri5a` to `000000`), preserving
the displayed layout and control boundaries.
