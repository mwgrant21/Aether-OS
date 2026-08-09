# Codex Terminal View — Design Spec

**Status:** approved, ready for planning.
**Depends on:** the cross-engine verification feature (`electron/crossEngine/`, currently
PRs #13/#16) for its dedicated, isolated `CODEX_HOME` and the billing-safety lessons learned
building it. This branch (`codex-terminal-view`) is stacked on `uplinks-real-status`.

---

## 1. What this is

A new, independent sidebar view — **Codex** — running a real, interactive `codex` CLI
session in its own pty. This is a second agent workspace alongside Claude's, not a
sandboxed reviewer: Codex gets the same category of access Claude's terminal already
has (arbitrary file read/write/execute, for as long as the session runs).

This is deliberately separate from the existing one-shot verifier
(`electron/crossEngine/`, `VERIFY WITH CODEX` button): that feature stays exactly as it
is — narrow, snapshot-isolated, auto-disposed, used for automated dispatch-claim
checks. This feature is for open-ended interactive work and second opinions. The two
share one thing only: the dedicated `CODEX_HOME` directory (one ChatGPT login serves
both).

## 2. Why not reuse the ACP client already built

Everything in `electron/crossEngine/` talks to Codex via the Agent Client Protocol —
a JSON-RPC client for one bounded, read-only check per invocation
(`mcpServers: []`, every permission request auto-denied). That is structurally the
wrong tool for "let me work with Codex the way I work with Claude." A real terminal
session needs the actual `codex` CLI's own interactive UI, which `AcpClient` never
touches.

The good news: the real `codex` CLI is launched exactly the way `claude` already is in
this codebase — as a shell command written into a pty, not a JS module invocation. This
means the new feature mirrors the *existing, working, already-battle-tested* terminal
pattern almost line for line, not the newer ACP machinery.

## 3. Architecture

**Main process — `electron/codexPtyManager.ts` (new)**, mirroring `electron/ptyManager.ts`:

```ts
const CODEX_LAUNCH_COMMAND = 'codex\r';
const API_KEY_ENV_VARS = ['OPENAI_API_KEY', 'CODEX_API_KEY'] as const; // + CODEX_HOME override

export function buildCodexPtyEnv(source: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of API_KEY_ENV_VARS) delete env[key];
  env.CODEX_HOME = codexHome; // the dedicated, isolated directory -- see SS4
  return env;
}

export function spawnCodexPty(cols = 100, rows = 30) {
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash';
  const codexHome = resolveCodexHome(); // reused from electron/crossEngine/acpProcess.ts
  const ptyProcess = pty.spawn(shell, [], { name: 'xterm-color', cols, rows, cwd: os.homedir(), env: buildCodexPtyEnv(process.env, codexHome) });
  ptyProcess.write(CODEX_LAUNCH_COMMAND);
  return ptyProcess;
}
```

`resolveCodexHome()` is imported from `electron/crossEngine/acpProcess.ts`, not
duplicated — same directory the verifier already uses, so a ChatGPT login done from
either surface satisfies both.

**IPC — new `codexPty:*` namespace**, exact mirror of the existing `pty:*` channels
(`electron/main.ts`, `electron/preload.ts`, `src/aetherElectron.d.ts`):
`codexPty:start`, `codexPty:write`, `codexPty:resize`, `codexPty:data` (push),
`codexPty:alive` (push), `codexPty:exit` (push). Independent from Claude's `pty:*`
channels — two separate ptys, two separate lifecycles, never share state.

**Superseded-exit safety:** reuse `electron/ptyLifecycle.ts`'s `PtyLifecycle` class (built
this session for Claude's pty) for the Codex pty too — a second instance if the class is
already generic, or a minimal generalization if it currently hardcodes Claude-specific
naming. Same rule applies: a stale exit event from a superseded pty must never flip
`codexTerminalAlive` false for a session that's actually still running.

**Renderer — `src/components/codexTerminal/`** (new directory):
- `CodexTerminalView.tsx` — mirrors `TerminalView.tsx`'s structure, but with only the
  terminal host, no rail cards (`SystemOverviewCard`/`ActiveAgentsCard`/`LiveOutputCard`
  are Claude-dispatch-specific and don't apply here — see SS6 scope boundary).
- `PtyCodexTerminal.tsx` — mirrors `PtyTerminal.tsx`'s xterm.js + `FitAddon` +
  module-level-singleton-survives-unmount pattern exactly, wired to `codexPty:*` instead
  of `pty:*`.

**Sidebar entry:** add `{ id: 'Codex', inSidebar: true, component: CodexTerminalView }`
to `src/viewRegistry.ts`'s `VIEWS` array.

## 4. Billing safety and privacy

- **Dedicated, isolated `CODEX_HOME`**, shared with the verifier (SS3). Never the
  operator's global `~/.codex` — the same isolation principle that protects the verifier
  protects this.
- **Env stripping**: `OPENAI_API_KEY`/`CODEX_API_KEY` are deleted from the pty's
  environment before the shell starts, the same way `buildPtyEnv()` already strips
  `ANTHROPIC_API_KEY`/etc. for Claude's terminal.
- **Named limitation, not silently absent:** unlike the ACP verifier — which
  structurally can never select API-key auth, because `AcpClient.authenticate()` only
  ever sends the literal `chat-gpt` method — a real interactive terminal cannot be
  stopped from an operator typing something like `codex login --api-key` by hand inside
  the session. Env-stripping and `CODEX_HOME` isolation reduce this risk (no key
  available to type *from* the environment) but do not eliminate the operator's own
  ability to enter one manually, the same category of limitation Claude's terminal
  already has and already documents.
- **Default-off, explicit opt-in**, mirroring the verifier's settings-card pattern: a
  new toggle (Settings, or folded into the existing Cross-Engine Verification card —
  implementation plan decides which reads better) gates whether the Codex pty spawns at
  all. Once enabled, it behaves symmetrically with Claude's terminal: auto-launches on
  every app start from then on, per the operator's explicit request during
  brainstorming — this is a deliberate deviation from the "lazy, first-click-only"
  pattern used elsewhere for Codex access, chosen because symmetry with the existing
  Terminal view was preferred over minimizing standing process count.
- **Privacy doc amendment required**: `docs/privacy-and-data.md` gains a second named
  exception (the verifier is the first), stating plainly that this session has the same
  open-ended file/exec access Claude's terminal already has, gated behind its own
  default-off toggle, sharing the verifier's `CODEX_HOME` isolation and env-stripping,
  with the manual-API-key-entry limitation stated explicitly.

## 5. Data flow

Operator enables the feature (Settings) → on next app start (or immediately, if already
running), `main.ts` calls `spawnCodexPty()` → pty spawns a shell, writes `codex\r` →
`codexPty:data` streams output to any mounted `PtyCodexTerminal` → operator types,
`codexPty:write` sends input → `codexPty:alive`/`codexPty:exit` track liveness for
display, mirroring `useTerminalAliveSync.ts`'s existing pattern (a parallel
`useCodexTerminalAliveSync.ts` or a generalized version, implementation plan decides).

## 6. Scope boundary (v1) — named, not silently missing

- **No cost/token tracking, no Ledger entry, no dispatch/narration integration.**
  Codex's usage isn't Anthropic-token-shaped, and none of the existing collector/ledger
  machinery applies to a ChatGPT-subscription-billed interactive session. This is a
  plain terminal.
- **No rail cards** (`SystemOverviewCard`/`ActiveAgentsCard`/`LiveOutputCard` stay
  Claude-only).
- **The existing verifier and its Uplinks/Settings status row are untouched.** "Is my
  ChatGPT subscription connected" (verifier) and "is a live Codex terminal running"
  (this feature) are two different, independent signals — this feature does not merge
  them into one display.
- **No generalization of the existing Claude pty machinery.** `ptyManager.ts`/
  `PtyTerminal.tsx`/`TerminalView.tsx` are mirrored, not refactored — see SS3's
  rejected-approach note. Not touched by this feature at all.

## 7. Testing

Mirror the existing pty test coverage:
- `codexPtyManager.test.ts`: env-stripping (OPENAI/CODEX keys removed, `CODEX_HOME` set
  to the dedicated directory), matching `ptyManager.test.ts`'s existing shape if one
  exists, or `acpProcess.test.ts`'s env-builder test shape otherwise.
- `PtyCodexTerminal` mount/unmount: session survives tab switch (module-level singleton
  pattern), matching `PtyTerminal.tsx`'s existing behavior.
- Superseded-exit safety for the Codex pty (reusing or extending `PtyLifecycle`'s
  existing test coverage).
- `viewRegistry.test.ts` updated for the new `Codex` sidebar entry.
- `docs/privacy-and-data.md` amendment reviewed for accuracy against what actually
  shipped, same discipline as the verifier's own privacy amendment.
