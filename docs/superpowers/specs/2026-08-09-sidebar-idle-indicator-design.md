# Sidebar Idle Indicator — Design Spec

**Status:** approved, ready for planning.
**Depends on:** the Codex Terminal View feature (`codexPty:*` IPC, `PtyCodexTerminal.tsx`) —
this branch (`sidebar-idle-indicator`) is stacked on `codex-terminal-view`.

---

## 1. What this is

A visual attention cue on the sidebar for the two interactive-terminal tabs (**Terminal**,
**Codex**): when a terminal has gone quiet for a few seconds and it isn't the tab you're
currently looking at, its sidebar nav item shows a pulsing indicator. The goal is to let the
operator tell "nothing new" from "something happened" without repeatedly switching tabs just
to check.

## 2. Detection: idle-timeout on output, not prompt parsing

Neither `claude` nor `codex` emits a structured "I'm now waiting for you to type" event to
this app — only raw pty output bytes. Two approaches were considered:

- **Idle-timeout heuristic (chosen):** if a pty is alive and produces no new output for a
  threshold window, treat it as idle. The same technique tmux (`monitor-silence`) and
  iTerm2 use for activity/silence indicators. Works identically for both terminals, no
  per-CLI parsing, low maintenance.
- **Prompt-pattern matching (rejected):** scan output for a recognizable prompt string.
  More precise in principle, but fragile — breaks silently if Claude Code or Codex change
  their terminal UI, and requires ANSI-stripping plus a reverse-engineered pattern per tool.

**Named limitation:** this is activity-silence, not literal "waiting for a keystroke" — a
long-running command with no console output (e.g. a quiet build step) also reads as idle.
Given the operator's stated goal (know when to check back in without switching tabs), this
is an acceptable, arguably correct, proxy — stated plainly rather than oversold as precise.

**Threshold: 3 seconds** of no new pty data.

## 3. Architecture

100% renderer-side. No new IPC channels, no main-process changes.
`electron/ptyManager.ts`/`codexPtyManager.ts` and `PtyTerminal.tsx`/`PtyCodexTerminal.tsx`
are untouched — `ipcRenderer.on('pty:data'/'codexPty:data', ...)` already supports multiple
independent listeners (confirmed in `electron/preload.ts`), so a dedicated idle-tracking
hook coexists with `PtyTerminal.tsx`'s own `onData` subscription without touching it.

**New hooks — `src/state/useTerminalIdleSync.ts` and `useCodexTerminalIdleSync.ts`**,
mirroring `useTerminalAliveSync.ts`'s existing shape exactly:

```ts
export function useTerminalIdleSync() {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    const pty = window.aetherElectron?.pty;
    if (!pty) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const markIdle = () => dispatch({ type: 'SET_TERMINAL_IDLE', idle: true });
    const markActive = () => {
      dispatch({ type: 'SET_TERMINAL_IDLE', idle: false });
      if (timer) clearTimeout(timer);
      timer = setTimeout(markIdle, IDLE_THRESHOLD_MS);
    };
    const unsubscribeData = pty.onData(markActive);
    const unsubscribeExit = pty.onExit(() => { if (timer) clearTimeout(timer); });
    return () => {
      unsubscribeData();
      unsubscribeExit();
      if (timer) clearTimeout(timer);
    };
  }, [dispatch]);
}
```

`useCodexTerminalIdleSync.ts` is the identical shape wired to `window.aetherElectron?.codexPty`
and `SET_CODEX_TERMINAL_IDLE`. Both mounted persistently in `App.tsx` via wrapper components
(`TerminalIdleSync`/`CodexTerminalIdleSync`, each `return null`), alongside the existing
`TerminalAliveSync`/`CodexTerminalAliveSync` — so tracking runs regardless of which tab is
currently active, matching the module-level pty singleton's own already-persistent lifetime.

## 4. State

- `state.terminalIdle: boolean`, default `false`.
- `state.codexTerminalIdle: boolean`, default `false`.
- New actions `SET_TERMINAL_IDLE` / `SET_CODEX_TERMINAL_IDLE`, reducer cases mirroring
  `SET_TERMINAL_ALIVE`/`SET_CODEX_TERMINAL_ALIVE` exactly.
- Both excluded from persistence (`PERSISTENCE_EXCLUSIONS`) — live/recomputed signals, same
  category as `terminalAlive`/`codexTerminalAlive`, not user-intent config.
- On `onExit`, the idle flag's pending timer is cleared (no stale idle flag lingers after a
  pty dies) but the flag itself is not force-set to `false` — an exited pty legitimately has
  nothing new to report, and `terminalAlive`/`codexTerminalAlive` already communicate the
  "is it even running" signal separately; idle is scoped to "no news," not liveness.

## 5. Sidebar rendering

`Sidebar.tsx` computes badge visibility per nav item as `idle && id !== state.activeTab` —
so the underlying idle state itself doesn't need to know about tab focus at all; the sidebar
simply never bothers you about the tab you're already looking at. Applies only to the
`'Terminal'` and `'Codex'` ids (the two ids this feature covers); every other sidebar item is
unaffected.

Visual treatment: the existing small square nav-dot (`navDotStyle` in `Sidebar.tsx`, currently
binary on/off for the active tab) gains a soft pulse animation in an attention color
(distinct from the existing cyan "active" accent) when the idle condition above is true.

## 6. Testing

- `buildIdleTimer`-equivalent logic (the debounce behavior itself) unit-tested directly:
  data event resets the timer, threshold elapsing without further data dispatches idle=true,
  exit clears the pending timer without forcing idle=false.
- Reducer tests for `SET_TERMINAL_IDLE`/`SET_CODEX_TERMINAL_IDLE`, mirroring the existing
  alive-action test shape, including a non-interference test (setting one never touches the
  other, matching the precedent set for `codexTerminalAlive`).
- `Sidebar.tsx` test: idle + not-active-tab renders the indicator; idle + active-tab does
  not; not-idle never renders it regardless of active tab.
- Persistence-exclusion test: both new fields present in `PERSISTENCE_EXCLUSIONS` (or
  equivalent coverage-enforcement test already in this codebase for `codexTerminalAlive`).

## 7. Scope boundary (v1)

- Only `Terminal` and `Codex` — no other sidebar item gets this treatment.
- No sound, no OS-level notification, no taskbar/dock badge — sidebar-only, matching the
  "single-user, local-only" scope of everything else in this app.
- No configurable threshold in Settings for v1 — 3 seconds is a fixed constant; making it
  user-configurable is straightforward future work if 3s proves wrong in practice, not
  built now (YAGNI).
