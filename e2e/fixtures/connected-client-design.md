# Built-production native fixture

The fixture imports the actual Electron production entrypoint and invokes its
real connected-session control, preflight, private launch script, native PTY,
prompt observer, preload and renderer. It never starts a model or MCP client.

The first native experiment replayed the sanitized tracked capture directly.
It remained `unknown`. Managed console writes produced an intermediate ConPTY
repaint; switching to one native WriteFile removed that intermediate frame but
did not establish recognition. Completing the frame with a visible cursor
removed an out-of-bounds cursor move but also remained `unknown`.

The revised approach is a deterministic supported native frame derived from
the captured prompt's recognized rows, omitting its full-width decorative rule.
The rule fills all 100 columns; ConPTY's canonical repaint uses implicit wrap
after that line, while the matcher deliberately rejects implicit autowrap.
This is fixture construction, not normalization of observed production bytes.
Keep the original capture as a separate replay case and retain native evidence.

The supported frame established positive recognition in native execution. Opening
Terminal then produced ConPTY `CSI 8;29;117 t` during the actual renderer resize.
With xterm's current default `windowOptions {}`, the matcher narrowly ignores
only `CSI 8;rows;cols t`; the physical resize path remains the sole geometry
source. The test observes that emitted sequence, verifies a supported resize and
repaint recover recognition, verifies unsupported 161-column geometry remains
unknown, then verifies an actual supported 100-column resize and repaint recover
without replacing the physical session.

The original JSON records post-PTY output. Sending it through another ConPTY is
a second transformation, so its unknown replay is not evidence of an installed
Claude defect or a faithful reproduction of the original capture session.

Focus may cause xterm device-query replies and focus reports (`CSI I/O`). The
test permits only those explicit terminal-protocol sequences in its native
write log; it rejects acceptance, Enter, pasted text and other user input.
Cleanup commands the owned fixture to exit through its private file and checks
the client PID, then closes Electron and checks every recorded shell PID.

No green fixture result proves the installed real client's full rendering
behavior, authenticated helper discovery, consultation, or paid model turn.
