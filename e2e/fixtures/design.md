# Connected native client fixture

`connected-client.cs` is a harmless, fixture-only native console client. It has
no model SDK, network access, MCP implementation, or child-process capability.
Commands arrive through the isolated fixture control file.

Input recording is opt-in and runs on a background thread so control-file exit
remains available after a failed paste. The `record` command uses raw Unicode
console input via `ReadConsoleW` as its fixture recording mode (processed, line,
and echo modes disabled), emits `AETHER_INPUT_RECORDING_READY`, then reads the connected console's standard
input until the test-only marker `AETHER_INPUT_RECORDING_COMPLETE_6C`. The fixture
writes the preceding UTF-16 console code units once as canonical UTF-8 to
`input-received.bin` and a length/SHA-256 receipt to `input-receipt.json`. This
is independent native console input evidence, not a claim about raw OS input
record bytes. Expected payload text is never supplied to the fixture.
Existing prompt capture, repaint, resize, replacement, and exit paths do not
start the reader and retain their previous behavior. Encoding the complete
UTF-16 input sequence once avoids surrogate-splitting artifacts from .NET's
byte-stream console wrapper. Raw mode also avoids mistaking Windows cooked-line
limits for a Claude or xterm transport limit.

The native composer test owns the clipboard before every paste and never reads
the user's prior clipboard. Product Copy and Focus actions remain separate from
Electron's native `webContents.paste()` command used for transport measurement.
The bootstrap blocks model-like child processes and exposes PTY writes separately
from fixture-received bytes so UI actions cannot masquerade as delivery proof.

`cross-check-main.cjs` is a separate Task 8 component harness. Two Electron processes use
different userData directories and independent bridge instances. Each connects the built MCP
helper over the real authenticated pipe and lists its tools. The production renderer/preload,
bridge IPC, PTY lifecycle, and prompt observer are used, but PTY events and provider completion
are deterministic test controls accessible only in Electron main. Clipboard copy and xterm DOM
focus are real Electron operations. Test code submits the copied JSON through the helper; no
Claude client reads the request, no skill is invoked, and no model runs. This closes the combined
isolation/delivery check alongside, not in place of, the native production and 6C paste tests.
