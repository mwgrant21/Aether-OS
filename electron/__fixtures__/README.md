# Electron fixtures

`trust-prompt-capture.json` is the original sanitized eight-callback capture.

`trust-prompt-long-path-capture.json` is an offline extraction of the initial frame in
`work/untrusted-launch-R5Ri5a/terminal-output.txt`, ending at the first visible `cancel` in the
confirmation line. The extraction includes the CSI `1C` between `to` and `cancel`. The source log
may later contain appended session output; the original PTY callback boundaries cannot be recovered,
so the extracted frame is intentionally represented as one chunk. Its username and launch suffix
were replaced with equal-width placeholders (`Matt` to `User`, `R5Ri5a` to `000000`), preserving
the displayed layout and control boundaries.

## Loading the trust-prompt captures

The fixtures have different chunk shapes. Do not apply one accessor to both:

- Original capture: `chunks: [{ at, data }]`; join with
  `capture.chunks.map(chunk => chunk.data).join('')`. The `at` values and chunk
  boundaries come from the recorded callbacks.
- Long-path extraction: `chunks: [string]`; join with
  `capture.chunks.join('')`. Its single chunk is an extracted frame, not a
  recorded callback, and has no timing data.

For streaming checks, feed each original `chunk.data` or each extracted string
to the matcher. Synthetic split-point tests do not reconstruct original
callback boundaries or timings.
