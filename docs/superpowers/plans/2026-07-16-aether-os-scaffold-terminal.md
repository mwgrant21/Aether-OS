# Aether OS — Scaffold + Terminal View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a fresh React + Vite + TypeScript project that recreates the Aether OS design handoff (`C:\Users\Matt\Documents\design_handoff_aether_os\`) pixel-for-pixel for the Terminal view — including the canvas/WebGL reactor core — plus the shared app chrome (top bar, sidebar, footer, bottom metrics row) all other views will later plug into.

**Architecture:** A single `useReducer`-backed store (no external state library) drives a flat `AetherState` matching the prototype's `state` shape, trimmed to the fields the Terminal view and shared chrome actually use (Projects/Memory/Grid/etc. state slices are added when those views are built — YAGNI). A 900ms `setInterval` runs a pure `computeTick` function each cycle, mirroring the prototype's simulation loop. The reactor core is isolated behind a `useReactorCanvas` hook owning three `<canvas>` refs (2D core, WebGL plasma, 2D conduits) and its own `requestAnimationFrame` loop + stall watchdog, kept outside React re-renders for performance. Pure logic (formatters, reducer, tick, command dispatch, reactor math) gets Vitest unit tests; presentational/canvas code is verified by running the dev server and visually checking against the design doc, since JSX layout and imperative canvas drawing aren't meaningfully unit-testable here.

**Tech Stack:** React 18, Vite 5, TypeScript 5 (strict), Vitest + jsdom for pure-logic tests. No CSS framework, no state-management library, no canvas library — the prototype has zero dependencies beyond React and this port keeps that footprint.

## Global Constraints

- Project root: `C:\Users\Matt\projects\aether-os`. This plan file lives at `docs/superpowers/plans/2026-07-16-aether-os-scaffold-terminal.md` inside that root.
- Source of truth for all values in this plan is `C:\Users\Matt\Documents\design_handoff_aether_os\Aether Agent OS.dc.html` (a proprietary single-file template format) and its `README.md`. Do not invent colors/spacing/behavior not present in one of those two files, except where explicitly noted below as a documented deviation or scope cut.
- Colors, fonts, radii, and animation timings must match the source file's inline styles exactly — they are copied verbatim into `src/styles/tokens.ts` and component style objects in this plan.
- Fonts: Rajdhani (400/500/600/700) for UI text, Space Mono (400/700) for numeric/terminal text, loaded via Google Fonts CDN exactly as in the source (`index.html`).
- Frame is fixed at 1536×1024 per the README; do not make it responsive in this pass.
- Scope for this plan is: project scaffold, shared chrome (top bar, sidebar, footer, bottom metrics row), and the Terminal view including the full 3-renderer reactor core (NEBULA/VOLUMETRIC/WARP). Chat/Agents/Grid/Projects/Memory/Analytics/Uplinks/Files/Settings views and their state slices are explicitly out of scope — clicking their nav/tab entries shows a small honest "not built yet" panel (`ComingSoonPanel`), not a broken screen.
- Two intentional deviations from the source (both called out again at point of use): (1) the `approve`/`deny` terminal command's original source has a text bug producing "denyd" instead of "denied" via string concatenation — this port outputs "denied" correctly. (2) the reactor's stall watchdog is moved from the app-wide 900ms tick (where the prototype's single-class-component architecture put it) into `useReactorCanvas` itself, since React lets us encapsulate it there — behavior is equivalent, just relocated.
- Known fidelity gap carried over from the source on purpose (matches original behavior, not a bug in this port): the footer's "Uptime" readout is a static string `3h 42m`, not derived from session start — same as the prototype.
- The five seed `agents` in `initialState.ts` (task descriptions, file names) are original-flavored but NOT verbatim-extracted from the source — the extraction pass summarized that array's shape rather than quoting literal values. Everything else in `initialState.ts` is verbatim.
- Run `npm test` and `npm run build` before every commit in this plan; both must be clean.

---

## File Structure

```
aether-os/
  index.html
  package.json
  tsconfig.json
  tsconfig.node.json
  vite.config.ts
  src/
    main.tsx
    App.tsx
    styles/
      global.css
      tokens.ts
      tokens.test.ts
    utils/
      format.ts
      format.test.ts
    state/
      types.ts
      initialState.ts
      reducer.ts
      reducer.test.ts
      tick.ts
      tick.test.ts
      persistence.ts
      persistence.test.ts
      store.tsx
    components/
      layout/
        AppShell.tsx
        TopBar.tsx
        Sidebar.tsx
        Footer.tsx
        ComingSoonPanel.tsx
        BottomMetricsRow.tsx
      terminal/
        TerminalView.tsx
        commands.ts
        commands.test.ts
        SystemOverviewCard.tsx
        ActiveAgentsCard.tsx
        LiveOutputCard.tsx
      reactor/
        ReactorCore.tsx
        useReactorCanvas.ts
        reactorMath.ts
        reactorMath.test.ts
        glShader.ts
        drawHousing.ts
        drawConduits.ts
        drawWarp.ts
```

Each file has one responsibility: `state/` never imports from `components/`; `reactor/` is self-contained and only exposes `ReactorCore` (a component) to the rest of the app; `terminal/commands.ts` is pure and has no React/DOM dependency so it's fully unit-testable.

---

### Task 1: Project scaffold & tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`, `index.html`
- Create: `src/main.tsx`, `src/App.tsx`, `src/styles/global.css`, `src/styles/tokens.ts`, `src/styles/tokens.test.ts`
- Create: `.gitignore`

**Interfaces:**
- Produces: `colors`, `fonts`, `radii` exports from `src/styles/tokens.ts` — every later component imports from here for shared values.

- [ ] **Step 1: Create the project directory and package.json**

```json
{
  "name": "aether-os",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.1",
    "typescript": "^5.6.3",
    "vite": "^5.4.11",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 3: Create tsconfig.node.json**

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: Create vite.config.ts (with Vitest config merged in)**

```ts
/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
  },
});
```

- [ ] **Step 5: Create index.html**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Aether OS</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap"
      rel="stylesheet"
    />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create src/styles/global.css**

Ported verbatim from the source's `<style>` block (reset + keyframes), plus a `--pulse-dur` default so `var(--pulse-dur, 2.4s)` fallbacks always have a defined starting value:

```css
* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  background: #020a10;
  color: #d8f6ff;
  -webkit-font-smoothing: antialiased;
  font-family: Rajdhani, sans-serif;
}

::selection {
  background: rgba(95, 220, 255, 0.3);
}

::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

::-webkit-scrollbar-thumb {
  background: rgba(80, 190, 220, 0.3);
  border-radius: 3px;
}

a {
  color: #7fd8ef;
  text-decoration: none;
}
a:hover {
  color: #bff4ff;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes spinRev {
  to {
    transform: rotate(-360deg);
  }
}
@keyframes breath {
  0%,
  100% {
    transform: scale(0.93);
    filter: brightness(0.85);
  }
  50% {
    transform: scale(1.07);
    filter: brightness(1.3);
  }
}
@keyframes scan {
  0% {
    transform: translateY(-30%);
    opacity: 0;
  }
  15% {
    opacity: 0.3;
  }
  100% {
    transform: translateY(520%);
    opacity: 0;
  }
}
@keyframes blink {
  0%,
  49% {
    opacity: 1;
  }
  50%,
  100% {
    opacity: 0;
  }
}
@keyframes conduitFlow {
  from {
    background-position: -60% 0;
  }
  to {
    background-position: 160% 0;
  }
}
@keyframes conduitFlowRev {
  from {
    background-position: 160% 0;
  }
  to {
    background-position: -60% 0;
  }
}
@keyframes conduitFlowV {
  from {
    background-position: 0 -60%;
  }
  to {
    background-position: 0 160%;
  }
}
@keyframes conduitFlowVRev {
  from {
    background-position: 0 160%;
  }
  to {
    background-position: 0 -60%;
  }
}
@keyframes dashFlow {
  to {
    stroke-dashoffset: -20;
  }
}
@keyframes slideIn {
  from {
    transform: translateX(36px);
    opacity: 0;
  }
  to {
    transform: none;
    opacity: 1;
  }
}

:root {
  --pulse-dur: 2.4s;
}
```

- [ ] **Step 7: Create src/styles/tokens.ts**

```ts
export const colors = {
  bgBase: '#020a10',
  pageRadial: 'radial-gradient(1400px 900px at 60% -10%, #0a2634 0%, #04121a 55%, #020a10 100%)',
  panelGradient: 'linear-gradient(180deg, rgba(9,28,38,.8), rgba(6,18,26,.8))',
  panelBorder: 'rgba(70,180,215,.24)',
  chromeBorder: 'rgba(70,180,215,.16)',
  chipBorder: 'rgba(80,190,220,.25)',
  activeBorder: 'rgba(95,220,255,.4)',
  textPrimary: '#eafcff',
  textBody: '#d8f6ff',
  textSecondary: '#9fc4d1',
  textMuted: '#5f8a97',
  textDim: '#4e7c8b',
  accentCyan: '#7ef0ff',
  accentCyanDeep: '#17b8d8',
  accentCyanSoft: '#7fd8ef',
  success: '#3be0a0',
  warn: '#f5c66b',
  danger: '#ff6b7a',
  dangerSoft: '#ff9d9d',
  agentHues: ['#7ef0ff', '#8ab6ff', '#5fffe0', '#7fd8ef', '#9bd0ff'] as const,
} as const;

export const fonts = {
  ui: 'Rajdhani, sans-serif',
  mono: "'Space Mono', monospace",
} as const;

export const radii = {
  panel: 14,
  tile: 9,
  chip: 7,
  pill: 30,
} as const;
```

- [ ] **Step 8: Write a smoke test to prove the Vitest harness works**

`src/styles/tokens.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { colors, fonts } from './tokens';

describe('tokens', () => {
  it('matches the source design doc base colors', () => {
    expect(colors.bgBase).toBe('#020a10');
    expect(colors.success).toBe('#3be0a0');
    expect(colors.danger).toBe('#ff6b7a');
  });

  it('exposes the two font stacks the design uses', () => {
    expect(fonts.ui).toContain('Rajdhani');
    expect(fonts.mono).toContain('Space Mono');
  });
});
```

- [ ] **Step 9: Run the test to confirm the harness works**

Run: `npm install && npm test`
Expected: 1 test file, 2 tests, all PASS.

- [ ] **Step 10: Create a minimal boot App.tsx and main.tsx**

`src/App.tsx` (replaced with the real shell in Task 7 — this is a genuine, complete deliverable for this task, not a TODO):

```tsx
import { colors, fonts } from './styles/tokens';

export default function App() {
  return (
    <div style={rootStyle}>
      <div style={{ font: `700 20px/1 ${fonts.ui}`, letterSpacing: 5, color: colors.textPrimary }}>
        AETHER<span style={{ color: colors.textMuted, fontWeight: 500 }}> OS</span>
      </div>
      <div style={{ marginTop: 12, font: `400 12px/1 ${fonts.mono}`, color: colors.textMuted }}>booting…</div>
    </div>
  );
}

const rootStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  background: colors.pageRadial,
};
```

`src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/global.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 11: Create .gitignore**

```
node_modules
dist
.DS_Store
*.local
```

- [ ] **Step 12: Verify the dev server**

Run: `npm run dev` (then open the printed local URL in a browser)
Expected: a black page with the radial gradient background, "AETHER OS" logotype centered, "booting…" underneath, in Rajdhani/Space Mono.

- [ ] **Step 13: Verify the build**

Run: `npm run build`
Expected: exits 0, produces `dist/`.

- [ ] **Step 14: Commit**

```bash
git init
git add package.json tsconfig.json tsconfig.node.json vite.config.ts index.html .gitignore src
git commit -m "chore: scaffold Aether OS with Vite + React + TypeScript + Vitest"
```

---

### Task 2: Format & time utilities

Ported verbatim from the source's `fmt`/`short`/`fmtEta`/`spark` methods (lines 2538–2547) plus its `now()` method (line 2262), split into short/long variants since the source used `.slice(0,8)` and `.slice(0,5)` on the same call at different sites.

**Files:**
- Create: `src/utils/format.ts`
- Test: `src/utils/format.test.ts`

**Interfaces:**
- Produces: `fmt(n): string`, `short(n): string`, `fmtEta(sec): string`, `spark(hist: number[]): string`, `nowLong(): string`, `nowShort(): string` — consumed by `tick.ts`, `commands.ts`, `reducer.ts`, and the right-rail cards.

- [ ] **Step 1: Write the failing tests**

`src/utils/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fmt, fmtEta, nowLong, nowShort, short, spark } from './format';

describe('fmt', () => {
  it('adds thousands separators to a rounded integer', () => {
    expect(fmt(24391)).toBe('24,391');
    expect(fmt(999.6)).toBe('1,000');
  });
});

describe('short', () => {
  it('abbreviates millions and thousands, leaves small numbers alone', () => {
    expect(short(1_500_000)).toBe('1.50M');
    expect(short(1500)).toBe('1.5K');
    expect(short(500)).toBe('500');
  });
});

describe('fmtEta', () => {
  it('returns n/a for non-finite or non-positive input', () => {
    expect(fmtEta(0)).toBe('n/a');
    expect(fmtEta(-5)).toBe('n/a');
    expect(fmtEta(NaN)).toBe('n/a');
    expect(fmtEta(Infinity)).toBe('n/a');
  });

  it('formats minutes-only when under an hour', () => {
    expect(fmtEta(90)).toBe('1m');
  });

  it('formats hours and minutes when over an hour', () => {
    expect(fmtEta(5400)).toBe('1h 30m');
  });
});

describe('spark', () => {
  it('maps a history array to a 62x20 SVG polyline points string', () => {
    expect(spark([1, 2, 3])).toBe('0.0,18.0 31.0,10.0 62.0,2.0');
  });
});

describe('nowLong/nowShort', () => {
  it('formats as HH:MM:SS and HH:MM', () => {
    expect(nowLong()).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(nowShort()).toMatch(/^\d{2}:\d{2}$/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- format`
Expected: FAIL — `format.ts` doesn't exist yet.

- [ ] **Step 3: Implement src/utils/format.ts**

```ts
export function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function short(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

export function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return 'n/a';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function spark(hist: number[]): string {
  const max = Math.max(...hist);
  const min = Math.min(...hist);
  const span = Math.max(1, max - min);
  return hist
    .map((v, i) => {
      const x = (i / (hist.length - 1)) * 62;
      const y = 20 - ((v - min) / span) * 16 - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function nowLong(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function nowShort(): string {
  return nowLong().slice(0, 5);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- format`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/utils/format.ts src/utils/format.test.ts
git commit -m "feat: port fmt/short/fmtEta/spark/now formatters from the design prototype"
```

---

### Task 3: State types & initial state

Trimmed from the source's full `state` object (lines 1516–1631) to the fields the Terminal view and shared chrome use. Dropped fields (Chat/Grid/Projects/Memory/Analytics/Uplinks/Files/Settings-only state: `chatMsgs`, `mcOpen`/`mcGoal`/`mcPlan`, `providers`, `uplinkCfg`, `ghAhead`/`ghLast`/`linkLog`, `memFeed`, `projActivity`, `openFile`, `uploads`, settings-only `cfg` keys like `maxAgents`/`model`/`decayDays`/`sweep`/`fontSize`/`timeout`/`showKey`/`sound`/`hardStop`) are a deliberate scope cut, not an oversight — they get added when those views are built. `projects`/`memories` are kept as minimal stub arrays (empty by default) purely so the Terminal `projects`/`sweep` commands have real, correct (if currently empty) data to operate on.

**Files:**
- Create: `src/state/types.ts`
- Create: `src/state/initialState.ts`

**Interfaces:**
- Produces: `AetherState`, `Agent`, `Approval`, `Notif`, `LogEntry`, `TermLine`, `SysMetric`, `IdleAgent`, `ProjectStub`, `MemoryStub`, `Cfg`, `OpMode`, `RendererMode`, `ThemeName`, `AlarmLevel` types, and `initialState: AetherState` — every other `state/`, `terminal/`, and `reactor/` file imports these.

- [ ] **Step 1: Create src/state/types.ts**

```ts
export interface AgentFile {
  s: string;
  n: string;
  c: string;
}

export interface Agent {
  i: string;
  name: string;
  task: string;
  pct: number;
  hue: string;
  eta: string;
  share: number;
  hist: number[];
  files: AgentFile[];
  paused?: boolean;
}

export interface IdleAgent {
  name: string;
  last: string;
}

export interface SysMetric {
  label: string;
  val: number;
  hist: number[];
}

export interface Approval {
  id: number;
  agent: string;
  i: string;
  hue: string;
  action: string;
  detail: string;
  risk: 'HIGH' | 'MED' | 'LOW';
}

export interface Notif {
  t: string;
  m: string;
  c: string;
}

export interface LogEntry {
  t: string;
  m: string;
  c: string;
}

export interface TermLine {
  t: string;
  c: string;
}

export interface ProjectStub {
  name: string;
  status: string;
  pct: number;
}

export interface MemoryStub {
  pinned: boolean;
  strength: number;
}

export type OpMode = 'PLAN' | 'EDITS' | 'AUTO';
export type RendererMode = 'classic' | 'volumetric' | 'warp';
export type ThemeName = 'cyan' | 'blue' | 'teal' | 'violet' | 'amber' | 'red';
export type AlarmLevel = 'ok' | 'warn' | 'crit';

export interface Cfg {
  opMode: OpMode;
  renderer: RendererMode;
  pulseMode: 'live' | 'ambient';
  theme: ThemeName;
  glow: number;
  glowFx: boolean;
  capM: number;
  alarm: number;
  autoThrottle: boolean;
}

export interface AetherState {
  used: number;
  rate: number;
  ctxUsed: number;
  weekRaw: number[];
  commandsRun: number;
  activeTab: string;
  selected: string | null;
  cmdVal: string;
  termHist: TermLine[];
  cmdHist: string[];
  histIdx: number;
  notifs: Notif[];
  unread: number;
  notifOpen: boolean;
  alarmLevel: AlarmLevel;
  apprOpen: boolean;
  approvals: Approval[];
  apprSeq: number;
  cfg: Cfg;
  agents: Agent[];
  idleList: IdleAgent[];
  sys: SysMetric[];
  logs: LogEntry[];
  projects: ProjectStub[];
  memories: MemoryStub[];
}
```

- [ ] **Step 2: Create src/state/initialState.ts**

```ts
import type { AetherState } from './types';

export const initialState: AetherState = {
  used: 24391,
  rate: 92000,
  ctxUsed: 78432,
  weekRaw: [46, 40, 44, 38, 50, 42, 62],
  commandsRun: 163,
  activeTab: 'Terminal',
  selected: null,
  cmdVal: '',
  termHist: [],
  cmdHist: [],
  histIdx: -1,
  notifs: [],
  unread: 0,
  notifOpen: false,
  alarmLevel: 'ok',
  apprOpen: false,
  approvals: [
    {
      id: 1,
      agent: 'Code Builder',
      i: 'CB',
      hue: '#7ef0ff',
      action: 'Deploy build #214 to production',
      detail: 'vercel · main → prod · 12 files changed',
      risk: 'HIGH',
    },
    {
      id: 2,
      agent: 'Database Agent',
      i: 'DB',
      hue: '#5fffe0',
      action: 'Run schema migration 0043',
      detail: 'adds index on usage_events · est 40s lock',
      risk: 'MED',
    },
  ],
  apprSeq: 3,
  cfg: {
    opMode: 'EDITS',
    renderer: 'classic',
    pulseMode: 'live',
    theme: 'cyan',
    glow: 70,
    glowFx: true,
    capM: 2.0,
    alarm: 120,
    autoThrottle: true,
  },
  agents: [
    {
      i: 'CB',
      name: 'Code Builder',
      task: 'Refactoring auth middleware',
      pct: 62,
      hue: '#7ef0ff',
      eta: '4m',
      share: 0.22,
      hist: [],
      files: [
        { s: '✓', n: 'routes/auth.js', c: '#3be0a0' },
        { s: '›', n: 'middleware/session.js', c: '#7fd8ef' },
      ],
    },
    {
      i: 'UI',
      name: 'UI Designer',
      task: 'Polishing dashboard cards',
      pct: 41,
      hue: '#8ab6ff',
      eta: '7m',
      share: 0.18,
      hist: [],
      files: [
        { s: '✓', n: 'components/Card.tsx', c: '#3be0a0' },
        { s: '›', n: 'components/Grid.tsx', c: '#7fd8ef' },
      ],
    },
    {
      i: 'DB',
      name: 'Database Agent',
      task: 'Indexing usage_events table',
      pct: 78,
      hue: '#5fffe0',
      eta: '2m',
      share: 0.2,
      hist: [],
      files: [{ s: '✓', n: 'migrations/0043.sql', c: '#3be0a0' }],
    },
    {
      i: 'TR',
      name: 'Test Runner',
      task: 'Running integration suite',
      pct: 55,
      hue: '#7fd8ef',
      eta: '5m',
      share: 0.15,
      hist: [],
      files: [{ s: '›', n: 'tests/auth.spec.ts', c: '#7fd8ef' }],
    },
    {
      i: 'DW',
      name: 'Doc Writer',
      task: 'Drafting API reference',
      pct: 24,
      hue: '#9bd0ff',
      eta: '9m',
      share: 0.13,
      hist: [],
      files: [{ s: '·', n: 'docs/api.md', c: '#4e7c8b' }],
    },
  ],
  idleList: [
    { name: 'Web Scraper', last: '2h ago' },
    { name: 'Doc Helper', last: '1d ago' },
  ],
  sys: [
    { label: 'CPU', val: 23, hist: [18, 25, 20, 30, 24, 22, 26, 23] },
    { label: 'MEM', val: 41, hist: [38, 42, 40, 45, 43, 39, 44, 41] },
    { label: 'NET', val: 18, hist: [12, 22, 16, 28, 14, 20, 17, 18] },
    { label: 'DISK', val: 31, hist: [30, 31, 30, 32, 31, 30, 31, 31] },
  ],
  logs: [],
  projects: [],
  memories: [],
};
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: exits 0 (no runtime logic here to unit test — this is pure data, verified by the type checker).

- [ ] **Step 4: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts
git commit -m "feat: define AetherState shape and seed initial state from the design prototype"
```

---

### Task 4: Reducer & actions

Ported from the source's scattered `setState` callbacks (`histNav` lines 2264–2273, `resolveApproval` lines 2284–2295, the notif-clearing bell toggle, the approval-shield toggle, and the op-mode segmented control). `RUN_COMMAND` delegates to `commands.ts`'s pure `runCommand`, which is built in Task 9 — this task defines the reducer case assuming that function's signature (declared in the Interfaces block below) so Task 9 can be implemented independently.

**Files:**
- Create: `src/state/reducer.ts`
- Test: `src/state/reducer.test.ts`

**Interfaces:**
- Consumes: `runCommand(state: AetherState, raw: string): CommandResult` from `../components/terminal/commands` (built in Task 9; `CommandResult = { kind: 'clear' } | { kind: 'append'; lines: TermLine[]; patch?: Partial<AetherState> }`), `computeTick(state: AetherState): Partial<AetherState>` from `./tick` (built in Task 5), `nowShort()` from `../utils/format`.
- Produces: `Action` union type and `reducer(state: AetherState, action: Action): AetherState` — consumed by `store.tsx` (Task 6) and every component that dispatches.

- [ ] **Step 1: Write the failing tests**

`src/state/reducer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { reducer } from './reducer';
import { initialState } from './initialState';

describe('reducer', () => {
  it('SET_ACTIVE_TAB switches the active tab', () => {
    const next = reducer(initialState, { type: 'SET_ACTIVE_TAB', tab: 'Agents' });
    expect(next.activeTab).toBe('Agents');
  });

  it('TOGGLE_NOTIFS opens the panel and clears unread', () => {
    const withUnread = { ...initialState, unread: 3, notifOpen: false };
    const next = reducer(withUnread, { type: 'TOGGLE_NOTIFS' });
    expect(next.notifOpen).toBe(true);
    expect(next.unread).toBe(0);
  });

  it('TOGGLE_APPROVALS flips apprOpen without touching unread', () => {
    const next = reducer(initialState, { type: 'TOGGLE_APPROVALS' });
    expect(next.apprOpen).toBe(true);
  });

  it('SELECT_AGENT sets selected', () => {
    const next = reducer(initialState, { type: 'SELECT_AGENT', name: 'Code Builder' });
    expect(next.selected).toBe('Code Builder');
  });

  it('HIST_NAV walks command history backwards then forwards to empty', () => {
    const withHist = { ...initialState, cmdHist: ['status', 'agents'], histIdx: -1 };
    const up1 = reducer(withHist, { type: 'HIST_NAV', up: true });
    expect(up1.cmdVal).toBe('agents');
    expect(up1.histIdx).toBe(1);
    const up2 = reducer(up1, { type: 'HIST_NAV', up: true });
    expect(up2.cmdVal).toBe('status');
    const down1 = reducer(up2, { type: 'HIST_NAV', up: false });
    expect(down1.cmdVal).toBe('agents');
    const down2 = reducer(down1, { type: 'HIST_NAV', up: false });
    expect(down2.cmdVal).toBe('');
    expect(down2.histIdx).toBe(-1);
  });

  it('RESOLVE_APPROVAL removes the request and bumps rate only for HIGH risk approvals', () => {
    const next = reducer(initialState, { type: 'RESOLVE_APPROVAL', id: 1, approve: true });
    expect(next.approvals.map((a) => a.id)).toEqual([2]);
    expect(next.rate).toBe(initialState.rate + 9000);
    expect(next.notifs[0].m).toContain('Approved');

    const denyMed = reducer(initialState, { type: 'RESOLVE_APPROVAL', id: 2, approve: false });
    expect(denyMed.rate).toBe(initialState.rate);
    expect(denyMed.notifs[0].m).toContain('Denied');
  });

  it('RESOLVE_APPROVAL on an unknown id is a no-op', () => {
    const next = reducer(initialState, { type: 'RESOLVE_APPROVAL', id: 999, approve: true });
    expect(next).toBe(initialState);
  });

  it('HYDRATE merges persisted state over defaults', () => {
    const next = reducer(initialState, { type: 'HYDRATE', state: { activeTab: 'Grid', unread: 4 } });
    expect(next.activeTab).toBe('Grid');
    expect(next.unread).toBe(4);
    expect(next.used).toBe(initialState.used);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- reducer`
Expected: FAIL — `reducer.ts` doesn't exist yet.

- [ ] **Step 3: Implement src/state/reducer.ts**

```ts
import type { AetherState, OpMode } from './types';
import { runCommand } from '../components/terminal/commands';
import { computeTick } from './tick';
import { nowShort } from '../utils/format';

export type Action =
  | { type: 'SET_ACTIVE_TAB'; tab: string }
  | { type: 'SET_CMD_VAL'; value: string }
  | { type: 'HIST_NAV'; up: boolean }
  | { type: 'TOGGLE_APPROVALS' }
  | { type: 'TOGGLE_NOTIFS' }
  | { type: 'RESOLVE_APPROVAL'; id: number; approve: boolean }
  | { type: 'SELECT_AGENT'; name: string }
  | { type: 'SET_OP_MODE'; mode: OpMode }
  | { type: 'RUN_COMMAND'; raw: string }
  | { type: 'TICK' }
  | { type: 'HYDRATE'; state: Partial<AetherState> };

export function reducer(state: AetherState, action: Action): AetherState {
  switch (action.type) {
    case 'SET_ACTIVE_TAB':
      return { ...state, activeTab: action.tab };

    case 'SET_CMD_VAL':
      return { ...state, cmdVal: action.value };

    case 'HIST_NAV': {
      const h = state.cmdHist;
      if (!h.length) return state;
      let i: number;
      if (action.up) i = state.histIdx < 0 ? h.length - 1 : Math.max(0, state.histIdx - 1);
      else {
        i = state.histIdx < 0 ? -1 : state.histIdx + 1;
        if (i >= h.length) i = -1;
      }
      return { ...state, histIdx: i, cmdVal: i < 0 ? '' : h[i] };
    }

    case 'TOGGLE_APPROVALS':
      return { ...state, apprOpen: !state.apprOpen };

    case 'TOGGLE_NOTIFS':
      return { ...state, notifOpen: !state.notifOpen, unread: 0 };

    case 'SELECT_AGENT':
      return { ...state, selected: action.name };

    case 'SET_OP_MODE':
      return {
        ...state,
        cfg: { ...state.cfg, opMode: action.mode },
        notifs: [{ t: nowShort(), m: `Operating mode set to ${action.mode}`, c: '#7fd8ef' }, ...state.notifs].slice(0, 12),
        unread: state.unread + 1,
      };

    case 'RESOLVE_APPROVAL': {
      const req = state.approvals.find((a) => a.id === action.id);
      if (!req) return state;
      const ok = action.approve;
      return {
        ...state,
        approvals: state.approvals.filter((a) => a.id !== action.id),
        notifs: [
          { t: nowShort(), m: `${ok ? 'Approved: ' : 'Denied: '}${req.action} (${req.agent})`, c: ok ? '#3be0a0' : '#ff9d9d' },
          ...state.notifs,
        ].slice(0, 12),
        logs: [
          ...state.logs,
          {
            t: nowShort(),
            m: `${req.agent}: ${ok ? 'authorization granted — ' : 'request denied — '}${req.action.toLowerCase()}`,
            c: ok ? '#3be0a0' : '#ff9d9d',
          },
        ].slice(-14),
        rate: ok && req.risk === 'HIGH' ? Math.min(168000, state.rate + 9000) : state.rate,
      };
    }

    case 'RUN_COMMAND': {
      const result = runCommand(state, action.raw);
      if (result.kind === 'clear') {
        return { ...state, termHist: [], cmdVal: '' };
      }
      const base = result.patch ? { ...state, ...result.patch } : state;
      return {
        ...base,
        termHist: [...base.termHist, ...result.lines].slice(-60),
        cmdVal: '',
        cmdHist: [...base.cmdHist, action.raw].slice(-30),
        histIdx: -1,
        commandsRun: base.commandsRun + 1,
      };
    }

    case 'TICK':
      return { ...state, ...computeTick(state) };

    case 'HYDRATE':
      return { ...state, ...action.state };

    default:
      return state;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- reducer`
Expected: still FAIL at this point, because `runCommand` (Task 9) and `computeTick` (Task 5) don't exist yet — TypeScript will error on the imports. This is expected; this task's tests only exercise reducer branches that don't touch `RUN_COMMAND`/`TICK`, so proceed to Step 5 with stub implementations and revisit once Tasks 5 and 9 land.

- [ ] **Step 4b: Add temporary stubs so this task's tests can run in isolation**

Create `src/state/tick.ts` with a temporary stub (replaced for real in Task 5):

```ts
import type { AetherState } from './types';

export function computeTick(_state: AetherState): Partial<AetherState> {
  return {};
}
```

Create `src/components/terminal/commands.ts` with a temporary stub (replaced for real in Task 9):

```ts
import type { AetherState, CommandResult } from '../../state/types';

export function runCommand(_state: AetherState, _raw: string): CommandResult {
  return { kind: 'append', lines: [] };
}
```

Add `CommandResult` to `src/state/types.ts` (append at end of file):

```ts
export type CommandResult =
  | { kind: 'clear' }
  | { kind: 'append'; lines: TermLine[]; patch?: Partial<AetherState> };
```

Run: `npm test -- reducer`
Expected: PASS, 8 tests. (Task 5 and Task 9 will overwrite these two stub files with real implementations — their own test suites cover them fully at that point.)

- [ ] **Step 5: Commit**

```bash
git add src/state/reducer.ts src/state/reducer.test.ts src/state/tick.ts src/state/types.ts src/components/terminal/commands.ts
git commit -m "feat: add AetherState reducer with tick/command stubs to unblock testing"
```

---

### Task 5: Tick simulation

Ported from the source's 900ms `setInterval` body (lines 1645–1720), with the GitHub/Uplinks-related block (`ghAhead`/`ghLast`/`linkLog`) dropped — that state doesn't exist in this port's trimmed `AetherState` (Uplinks view is out of scope). Everything else — burn-rate random walk, auto-throttle governor, token/context drift, per-agent progress, sys sparklines, log lines, alarm-level transitions, and probabilistic approval requests — is ported exactly.

**Files:**
- Modify: `src/state/tick.ts` (replacing Task 4's stub)
- Test: `src/state/tick.test.ts`

**Interfaces:**
- Consumes: `AetherState`, `AlarmLevel` from `./types`; `nowLong`, `nowShort` from `../utils/format`.
- Produces: `computeTick(state: AetherState): Partial<AetherState>` — consumed by `reducer.ts`'s `TICK` case (already wired in Task 4).

- [ ] **Step 1: Write the failing tests**

`src/state/tick.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeTick } from './tick';
import { initialState } from './initialState';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('computeTick', () => {
  it('clamps rate to [20000, 168000] regardless of inputs', () => {
    const result = computeTick({ ...initialState, rate: 200000, cfg: { ...initialState.cfg, autoThrottle: false } });
    expect(result.rate).toBeLessThanOrEqual(168000);
    expect(result.rate).toBeGreaterThanOrEqual(20000);
  });

  it('auto-throttle caps rate at 80% of the alarm threshold', () => {
    const result = computeTick({
      ...initialState,
      rate: 168000,
      cfg: { ...initialState.cfg, autoThrottle: true, alarm: 120 },
    });
    expect(result.rate).toBeLessThanOrEqual(96000);
  });

  it('is fully deterministic with Math.random pinned to 0.5', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const state = { ...initialState, agents: [], cfg: { ...initialState.cfg, opMode: 'EDITS' as const, autoThrottle: true, alarm: 120 } };
    const result = computeTick(state);
    expect(result.rate).toBeCloseTo(84080, 5);
    expect(result.alarmLevel).toBe('ok');
    expect(result.approvals).toEqual(state.approvals);
  });

  it('flips alarmLevel to crit and fires a notification when the burn rate crosses the alarm threshold', () => {
    const state = { ...initialState, rate: 168000, agents: [], cfg: { ...initialState.cfg, alarm: 50, autoThrottle: false } };
    const result = computeTick(state);
    expect(result.alarmLevel).toBe('crit');
    expect(result.notifs).toHaveLength(1);
    expect(result.notifs![0].m).toContain('BURN ALARM');
    expect(result.unread).toBe(1);
  });

  it('never grows the approvals queue past 3 pending requests', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    const state = {
      ...initialState,
      approvals: [...initialState.approvals, { id: 99, agent: 'X', i: 'X', hue: '#fff', action: 'a', detail: 'b', risk: 'LOW' as const }],
    };
    const result = computeTick(state);
    expect(result.approvals!.length).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tick`
Expected: FAIL — the stub `computeTick` returns `{}`, so `result.rate` etc. are `undefined`.

- [ ] **Step 3: Implement src/state/tick.ts**

```ts
import type { AetherState, AlarmLevel } from './types';
import { nowLong, nowShort } from '../utils/format';

const LOG_MESSAGES = [
  'Code Builder: merging changes…',
  'UI Designer: refining spacing…',
  'API Builder: validating schema…',
  'Test Runner: 156 tests passing',
  'Database Agent: 8 tables optimized',
  'Reactor surge nominal',
  'Cache warmed · 12ms',
  '✓ Assets optimized',
];

const APPROVAL_POOL = [
  { action: 'Install dependency: chart.js@5', detail: 'adds 42KB to bundle · 3 transitive deps', risk: 'LOW' as const },
  { action: 'Force-push rebase to feature branch', detail: 'rewrites 4 commits on origin', risk: 'MED' as const },
  { action: 'Purge CDN cache (all routes)', detail: 'cold cache for ~2 min after purge', risk: 'MED' as const },
  { action: 'Call external pricing API', detail: 'sends anonymized usage rows offsite', risk: 'HIGH' as const },
  { action: 'Raise burn ceiling by 20K/min', detail: 'temporary boost to finish mission faster', risk: 'HIGH' as const },
  { action: 'Delete stale branch cleanup/old-ui', detail: 'last commit 34 days ago', risk: 'LOW' as const },
];

export function computeTick(state: AetherState): Partial<AetherState> {
  const mode = state.cfg.opMode;
  const target = Math.min(160000, 26000 + state.agents.length * 21000) * (mode === 'PLAN' ? 0.55 : mode === 'AUTO' ? 1.1 : 1);
  let rate = state.rate + (target - state.rate) * 0.12 + (Math.random() - 0.5) * 20000;
  rate = Math.max(20000, Math.min(168000, rate));
  if (state.cfg.autoThrottle) rate = Math.min(rate, state.cfg.alarm * 1000 * 0.8);

  const used = state.used + (rate / 60) * 0.9 * 0.05;
  const ctxUsed = Math.min(123000, state.ctxUsed + Math.random() * 40);

  const weekRaw = state.weekRaw.slice();
  weekRaw[6] = Math.min(72, weekRaw[6] + Math.random() * 0.35);

  const agents = state.agents.map((a) => ({
    ...a,
    pct: a.paused ? a.pct : Math.min(99, a.pct + (Math.random() - 0.3) * 1.5),
    hist: a.hist.slice(-15).concat(rate * a.share * (0.85 + Math.random() * 0.3)),
  }));

  const sys = state.sys.map((m) => {
    const val = Math.max(6, Math.min(96, m.val + (Math.random() - 0.5) * 5));
    return { ...m, val, hist: m.hist.slice(1).concat(val) };
  });

  let logs = state.logs;
  if (Math.random() < 0.3) {
    const msg = LOG_MESSAGES[Math.floor(Math.random() * LOG_MESSAGES.length)];
    logs = logs.concat({ t: nowLong(), m: msg, c: Math.random() < 0.2 ? '#3be0a0' : '#7fd8ef' }).slice(-14);
  }

  const alarm = state.cfg.alarm;
  const rateK = rate / 1000;
  const level: AlarmLevel = rateK >= alarm ? 'crit' : rateK >= alarm * 0.85 ? 'warn' : 'ok';

  let notifs = state.notifs;
  let unread = state.unread;
  if (level !== state.alarmLevel && level !== 'ok') {
    notifs = [
      {
        t: nowShort(),
        m: level === 'crit' ? `BURN ALARM — rate exceeds ${alarm}K/min` : 'Burn elevated — approaching alarm threshold',
        c: level === 'crit' ? '#ff6b7a' : '#f5c66b',
      },
      ...notifs,
    ].slice(0, 12);
    unread += 1;
  }

  let approvals = state.approvals;
  let apprSeq = state.apprSeq;
  if (agents.length && approvals.length < 3 && Math.random() < (mode === 'PLAN' ? 0.09 : 0.035)) {
    const req = APPROVAL_POOL[Math.floor(Math.random() * APPROVAL_POOL.length)];
    const ag = agents[Math.floor(Math.random() * agents.length)];
    if (mode === 'AUTO' && req.risk !== 'HIGH') {
      logs = logs.concat({ t: nowLong(), m: `${ag.name}: auto-approved — ${req.action.toLowerCase()}`, c: '#3be0a0' }).slice(-14);
      notifs = [{ t: nowShort(), m: `Auto-approved: ${req.action} (${ag.name})`, c: '#3be0a0' }, ...notifs].slice(0, 12);
      unread += 1;
    } else {
      approvals = approvals.concat({ id: apprSeq, agent: ag.name, i: ag.i, hue: ag.hue, ...req });
      apprSeq += 1;
      notifs = [{ t: nowShort(), m: `${ag.name} requests approval: ${req.action}`, c: '#f5c66b' }, ...notifs].slice(0, 12);
      unread += 1;
    }
  }

  return { rate, used, ctxUsed, weekRaw, agents, sys, logs, alarmLevel: level, notifs, unread, approvals, apprSeq };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tick`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/state/tick.ts src/state/tick.test.ts
git commit -m "feat: port the 900ms simulation tick from the design prototype"
```

---

### Task 6: Persistence & store hook

Ported from the source's `componentDidMount` load (lines 1633–1637) and debounced `persist()` (lines 1727–1740), trimmed to the fields this port's `AetherState` actually has (dropped `uplinkCfg`/`routeDefault`/`projects`/`memories`/`providers`/`projActivity`/`memFeed`/`linkLog`/`ghAhead`/`ghLast` — none of that state exists in this port's scope). The 900ms tick interval and the debounced persist effect are wired into a `useReducer` + `Context` store, replacing the source's single class component's `setState`/`componentDidUpdate`.

**Files:**
- Create: `src/state/persistence.ts`
- Test: `src/state/persistence.test.ts`
- Create: `src/state/store.tsx`

**Interfaces:**
- Consumes: `AetherState` from `./types`, `initialState` from `./initialState`, `reducer`/`Action` from `./reducer`.
- Produces: `loadPersisted(): Partial<AetherState> | null`, `savePersisted(state): void`, `AetherStoreProvider` component, `useAetherStore(): { state: AetherState; dispatch: Dispatch<Action> }` hook — every component from Task 7 onward reads state via `useAetherStore()`.

- [ ] **Step 1: Write the failing tests**

`src/state/persistence.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPersisted, savePersisted } from './persistence';
import { initialState } from './initialState';

beforeEach(() => {
  localStorage.clear();
});

describe('persistence', () => {
  it('round-trips a whitelisted slice of state through localStorage', () => {
    savePersisted({ ...initialState, activeTab: 'Grid', unread: 5 });
    const loaded = loadPersisted();
    expect(loaded?.activeTab).toBe('Grid');
    expect(loaded?.unread).toBe(5);
  });

  it('returns null when nothing is stored', () => {
    expect(loadPersisted()).toBeNull();
  });

  it('returns null on malformed JSON instead of throwing', () => {
    localStorage.setItem('aetheros-v1', '{not json');
    expect(loadPersisted()).toBeNull();
  });

  it('does not throw when localStorage.setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => savePersisted(initialState)).not.toThrow();
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- persistence`
Expected: FAIL — `persistence.ts` doesn't exist yet.

- [ ] **Step 3: Implement src/state/persistence.ts**

```ts
import type { AetherState } from './types';

const STORAGE_KEY = 'aetheros-v1';

export function loadPersisted(): Partial<AetherState> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<AetherState>;
  } catch {
    return null;
  }
}

export function savePersisted(state: AetherState): void {
  try {
    const slice: Partial<AetherState> = {
      cfg: state.cfg,
      activeTab: state.activeTab,
      agents: state.agents,
      idleList: state.idleList,
      notifs: state.notifs,
      unread: state.unread,
      cmdHist: state.cmdHist,
      approvals: state.approvals,
      apprSeq: state.apprSeq,
      logs: state.logs,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slice));
  } catch {
    // localStorage unavailable (private mode, quota) — persistence is best-effort
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- persistence`
Expected: PASS, 4 tests.

- [ ] **Step 5: Implement src/state/store.tsx**

```tsx
import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from 'react';
import { initialState } from './initialState';
import { reducer, type Action } from './reducer';
import type { AetherState } from './types';
import { loadPersisted, savePersisted } from './persistence';

interface StoreValue {
  state: AetherState;
  dispatch: Dispatch<Action>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function AetherStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState, (init) => {
    const persisted = loadPersisted();
    return persisted ? { ...init, ...persisted } : init;
  });

  useEffect(() => {
    const id = setInterval(() => dispatch({ type: 'TICK' }), 900);
    return () => clearInterval(id);
  }, []);

  const persistTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => savePersisted(state), 600);
    return () => clearTimeout(persistTimer.current);
  }, [state]);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useAetherStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useAetherStore must be used within AetherStoreProvider');
  return ctx;
}
```

- [ ] **Step 6: Verify via the dev server**

Wrap `App.tsx`'s content in `<AetherStoreProvider>` temporarily (Task 7 does this for real once the shell exists):

Run: `npm run dev`, open the browser, open devtools console, run `JSON.parse(localStorage.getItem('aetheros-v1'))` after a few seconds.
Expected: an object with `cfg`, `activeTab`, `agents`, etc. — confirms the debounced persist effect fired. Reloading the page should not throw (hydration path exercised).

- [ ] **Step 7: Commit**

```bash
git add src/state/persistence.ts src/state/persistence.test.ts src/state/store.tsx
git commit -m "feat: add localStorage persistence and the AetherStoreProvider/useAetherStore hook"
```

---

### Task 7: TopBar, Sidebar, Footer, AppShell, ComingSoonPanel

Ported from the source's top-bar template (lines 37–105), sidebar template (lines 109–134) with its `nav`/`recent` computation (lines 2552–2566, 3308–3313), footer template (lines 1505–1511) with its `footerLabel`/`footerC` derivation (lines 2959–2960), and the segmented tabs/op-mode arrays (lines 2568–2580, 3162–3181). All inline `style="..."` strings are converted to camelCase `React.CSSProperties` objects with identical values. `ComingSoonPanel` is new (not in the source) — an honest stand-in for the 8 views this plan doesn't build, styled with the same card system as everything else so it doesn't look broken.

This task also replaces Task 1's placeholder `App.tsx` with the real shell wiring `AetherStoreProvider` → `AppShell` → per-tab view.

**Files:**
- Create: `src/components/layout/TopBar.tsx`
- Create: `src/components/layout/Sidebar.tsx`
- Create: `src/components/layout/Footer.tsx`
- Create: `src/components/layout/AppShell.tsx`
- Create: `src/components/layout/ComingSoonPanel.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useAetherStore()` from `../../state/store`; `colors`/`fonts` from `../../styles/tokens`.
- Produces: `AppShell({ children })`, `TopBar()`, `Sidebar()`, `Footer()`, `ComingSoonPanel({ tabName })` components. `AppShell` is the single place that lays out the 1536×1024 frame; Task 8 adds `BottomMetricsRow` inside it.

This task has no unit-testable logic (pure layout + store reads) — verification is running the dev server and comparing against the design doc's screenshots/description.

- [ ] **Step 1: Implement src/components/layout/TopBar.tsx**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { OpMode } from '../../state/types';

const TAB_LABELS = ['Terminal', 'Chat', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Files'];
const OP_MODES: { key: OpMode; label: string; tip: string }[] = [
  { key: 'PLAN', label: '◇ PLAN', tip: 'Brainstorm & plan — throttled burn, everything queued for approval' },
  { key: 'EDITS', label: '✎ EDITS', tip: 'Accept edits — agents work, risky actions queue for approval' },
  { key: 'AUTO', label: '⚡ AUTO', tip: 'Full auto — low/med actions auto-approved, max burn' },
];

export function TopBar() {
  const { state, dispatch } = useAetherStore();
  const pendingCount = state.approvals.length;
  const hasPending = pendingCount > 0;
  const apprBtnC = hasPending ? colors.warn : colors.accentCyanSoft;
  const apprBtnBorder = hasPending ? 'rgba(245,198,107,.5)' : 'rgba(80,190,220,.25)';

  return (
    <div style={rootStyle}>
      <div style={logoWrapStyle}>
        <div style={logoDotStyle} />
        <div style={logoTextStyle}>
          AETHER<span style={{ color: colors.textMuted, fontWeight: 500 }}> OS</span>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', gap: 4 }}>
        {TAB_LABELS.map((label) => {
          const on = label === state.activeTab;
          return (
            <div key={label} onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: label })} style={tabStyle(on)}>
              {label}
            </div>
          );
        })}
      </div>

      <div style={opModeGroupStyle}>
        {OP_MODES.map((om) => {
          const on = state.cfg.opMode === om.key;
          return (
            <span key={om.key} title={om.tip} onClick={() => dispatch({ type: 'SET_OP_MODE', mode: om.key })} style={opModeStyle(on, om.key)}>
              {om.label}
            </span>
          );
        })}
      </div>

      <div style={{ position: 'relative', flex: 'none', marginRight: 10 }}>
        <div onClick={() => dispatch({ type: 'TOGGLE_APPROVALS' })} style={{ ...iconButtonStyle, borderColor: apprBtnBorder, color: apprBtnC }}>
          ⛉
        </div>
        {hasPending && <span style={apprBadgeStyle}>{pendingCount}</span>}
        {state.apprOpen && (
          <div style={apprPanelStyle}>
            <div style={panelTitleStyle}>⛉ APPROVAL QUEUE — agents awaiting authorization</div>
            {state.approvals.map((ap) => (
              <div key={ap.id} style={apprRowStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={apprAvatarStyle(ap.hue)}>{ap.i}</span>
                  <span style={apprActionStyle}>{ap.action}</span>
                  <span style={riskBadgeStyle(ap.risk)}>{ap.risk}</span>
                </div>
                <div style={apprDetailStyle}>
                  {ap.agent} · {ap.detail}
                </div>
                <div style={{ display: 'flex', gap: 7 }}>
                  <span onClick={() => dispatch({ type: 'RESOLVE_APPROVAL', id: ap.id, approve: true })} style={approveBtnStyle}>
                    APPROVE
                  </span>
                  <span onClick={() => dispatch({ type: 'RESOLVE_APPROVAL', id: ap.id, approve: false })} style={denyBtnStyle}>
                    DENY
                  </span>
                </div>
              </div>
            ))}
            {!state.approvals.length && <div style={emptyStateStyle}>queue clear — no agents awaiting authorization</div>}
          </div>
        )}
      </div>

      <div style={{ position: 'relative', flex: 'none', marginRight: 10 }}>
        <div onClick={() => dispatch({ type: 'TOGGLE_NOTIFS' })} style={{ ...iconButtonStyle, color: colors.accentCyanSoft }}>
          ◈
        </div>
        {state.unread > 0 && <span style={notifBadgeStyle}>{state.unread}</span>}
        {state.notifOpen && (
          <div style={notifPanelStyle}>
            <div style={{ font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted }}>NOTIFICATIONS</div>
            {state.notifs.map((nf, idx) => (
              <div key={idx} style={{ display: 'flex', gap: 8, font: `400 10.5px/1.5 ${fonts.mono}` }}>
                <span style={{ color: colors.textDim, flex: 'none' }}>{nf.t}</span>
                <span style={{ color: nf.c }}>{nf.m}</span>
              </div>
            ))}
            {!state.notifs.length && <div style={emptyStateStyle}>no alerts — reactor calm</div>}
          </div>
        )}
      </div>

      <div style={operatorChipStyle}>
        <div style={operatorAvatarStyle} />
        <div>
          <div style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textPrimary }}>operator</div>
          <div style={{ font: `400 10px/1 ${fonts.mono}`, color: colors.textMuted, marginTop: 3 }}>COMMAND DECK</div>
        </div>
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = {
  height: 60,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 22px',
  borderBottom: `1px solid ${colors.chromeBorder}`,
  background: 'rgba(4,16,24,.6)',
};
const logoWrapStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, width: 206 };
const logoDotStyle: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: '50%',
  background: 'radial-gradient(circle at 44% 38%, #fff, #7ef0ff 32%, #17b8d8 66%)',
  boxShadow: '0 0 14px rgba(95,240,255,.85)',
  animation: 'breath var(--pulse-dur, 2.4s) ease-in-out infinite',
};
const logoTextStyle: CSSProperties = { font: `700 20px/1 ${fonts.ui}`, letterSpacing: 5, color: colors.textPrimary };
function tabStyle(on: boolean): CSSProperties {
  return {
    padding: '8px 15px',
    borderRadius: 8,
    font: `600 13px/1 ${fonts.ui}`,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    cursor: 'pointer',
    color: on ? colors.textPrimary : colors.textMuted,
    background: on ? 'rgba(23,184,216,.14)' : undefined,
    border: on ? '1px solid rgba(95,220,255,.35)' : '1px solid transparent',
  };
}
const opModeGroupStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  gap: 2,
  alignItems: 'center',
  marginRight: 12,
  padding: 3,
  borderRadius: 9,
  border: '1px solid rgba(80,190,220,.25)',
  background: 'rgba(10,32,43,.6)',
};
function opModeStyle(on: boolean, key: OpMode): CSSProperties {
  return {
    cursor: 'pointer',
    padding: '7px 11px',
    borderRadius: 7,
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1.5,
    whiteSpace: 'nowrap',
    transition: 'all .15s',
    color: on ? (key === 'AUTO' ? '#1a1204' : '#04202b') : colors.textMuted,
    background: on ? (key === 'AUTO' ? 'linear-gradient(180deg,#f5c66b,#d9a13f)' : 'linear-gradient(180deg,#7ef0ff,#17b8d8)') : undefined,
    boxShadow: on ? (key === 'AUTO' ? '0 0 12px rgba(245,198,107,.45)' : '0 0 12px rgba(95,220,255,.4)') : undefined,
    border: on ? undefined : '1px solid transparent',
  };
}
const iconButtonStyle: CSSProperties = {
  cursor: 'pointer',
  width: 36,
  height: 36,
  borderRadius: 10,
  border: '1px solid rgba(80,190,220,.25)',
  background: 'rgba(10,32,43,.6)',
  display: 'grid',
  placeItems: 'center',
  font: `700 14px/1 ${fonts.mono}`,
};
const apprBadgeStyle: CSSProperties = {
  position: 'absolute',
  top: -4,
  right: -4,
  minWidth: 16,
  height: 16,
  borderRadius: 8,
  background: colors.warn,
  boxShadow: '0 0 10px rgba(245,198,107,.7)',
  display: 'grid',
  placeItems: 'center',
  font: `700 9px/1 ${fonts.mono}`,
  color: '#1a1204',
  padding: '0 4px',
};
const notifBadgeStyle: CSSProperties = {
  position: 'absolute',
  top: -7,
  right: -7,
  minWidth: 16,
  height: 16,
  borderRadius: 8,
  background: colors.danger,
  boxShadow: '0 0 10px rgba(255,107,122,.7)',
  display: 'grid',
  placeItems: 'center',
  font: `700 9px/1 ${fonts.mono}`,
  color: '#1a0508',
  padding: '0 4px',
};
const apprPanelStyle: CSSProperties = {
  position: 'absolute',
  top: 44,
  right: 0,
  width: 380,
  zIndex: 70,
  padding: 13,
  borderRadius: 12,
  border: '1px solid rgba(245,198,107,.4)',
  background: 'rgba(6,20,28,.98)',
  boxShadow: '0 20px 60px rgba(0,0,0,.6)',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};
const notifPanelStyle: CSSProperties = {
  position: 'absolute',
  top: 44,
  right: 0,
  width: 320,
  zIndex: 70,
  padding: 12,
  borderRadius: 12,
  border: '1px solid rgba(95,220,255,.35)',
  background: 'rgba(6,20,28,.98)',
  boxShadow: '0 20px 60px rgba(0,0,0,.6)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const panelTitleStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.warn };
const apprRowStyle: CSSProperties = {
  padding: '10px 11px',
  borderRadius: 9,
  border: '1px solid rgba(80,190,220,.2)',
  background: 'rgba(9,28,38,.7)',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};
function apprAvatarStyle(hue: string): CSSProperties {
  return {
    width: 22,
    height: 22,
    flex: 'none',
    borderRadius: 6,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 4px,#123f4e 4px 8px)',
    border: `1px solid ${hue}`,
    display: 'grid',
    placeItems: 'center',
    font: `700 9px/1 ${fonts.mono}`,
    color: hue,
  };
}
const apprActionStyle: CSSProperties = { flex: 1, font: `600 12px/1.3 ${fonts.ui}`, color: colors.textPrimary };
function riskBadgeStyle(risk: 'HIGH' | 'MED' | 'LOW'): CSSProperties {
  const c = risk === 'HIGH' ? colors.danger : risk === 'MED' ? colors.warn : colors.success;
  return { flex: 'none', font: `600 8px/1 ${fonts.ui}`, letterSpacing: 1, color: c, border: `1px solid ${c}55`, padding: '3px 6px', borderRadius: 4 };
}
const apprDetailStyle: CSSProperties = { font: `400 10px/1.5 ${fonts.mono}`, color: colors.textMuted };
const approveBtnStyle: CSSProperties = {
  flex: 1,
  textAlign: 'center',
  cursor: 'pointer',
  font: `600 10px/1 ${fonts.ui}`,
  letterSpacing: 1.5,
  color: colors.success,
  border: '1px solid rgba(59,224,160,.45)',
  padding: '7px 0',
  borderRadius: 6,
  background: 'rgba(59,224,160,.08)',
};
const denyBtnStyle: CSSProperties = {
  flex: 1,
  textAlign: 'center',
  cursor: 'pointer',
  font: `600 10px/1 ${fonts.ui}`,
  letterSpacing: 1.5,
  color: colors.dangerSoft,
  border: '1px solid rgba(255,120,120,.4)',
  padding: '7px 0',
  borderRadius: 6,
  background: 'rgba(255,90,90,.06)',
};
const emptyStateStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim };
const operatorChipStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '6px 10px',
  borderRadius: 30,
  border: '1px solid rgba(80,190,220,.25)',
  background: 'rgba(10,32,43,.6)',
};
const operatorAvatarStyle: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: '50%',
  background: 'repeating-linear-gradient(45deg,#0e3a48 0 5px,#12475a 5px 10px)',
  border: '1px solid rgba(95,220,255,.4)',
};
```

- [ ] **Step 2: Implement src/components/layout/Sidebar.tsx**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

const NAV_ITEMS = ['Dashboard', 'Terminal', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Uplinks', 'Settings'];
const CLICKABLE = new Set(['Dashboard', 'Terminal', 'Chat', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Settings', 'Files', 'Uplinks']);
const RECENT_AGENTS = [
  { i: 'CB', label: 'Code Builder', ring: '#7ef0ff' },
  { i: 'UI', label: 'UI Designer', ring: '#8ab6ff' },
  { i: 'DB', label: 'Database Agent', ring: '#5fffe0' },
  { i: 'TR', label: 'Test Runner', ring: '#7fd8ef' },
];

export function Sidebar() {
  const { state, dispatch } = useAetherStore();
  return (
    <div style={rootStyle}>
      <div style={sectionLabelStyle}>NAVIGATION</div>
      {NAV_ITEMS.map((label) => {
        const on = label === state.activeTab;
        const clickable = CLICKABLE.has(label);
        return (
          <div
            key={label}
            onClick={clickable ? () => dispatch({ type: 'SET_ACTIVE_TAB', tab: label }) : undefined}
            style={navItemStyle(on, clickable)}
          >
            <span style={navDotWrapStyle(on)}>
              <span style={navDotStyle(on)} />
            </span>
            <span style={{ font: `600 14px/1 ${fonts.ui}`, letterSpacing: 1 }}>{label}</span>
          </div>
        );
      })}

      <div style={{ ...sectionLabelStyle, marginTop: 14 }}>RECENT AGENTS</div>
      {RECENT_AGENTS.map((r) => (
        <div key={r.i} style={recentRowStyle}>
          <span style={recentAvatarStyle(r.ring)}>{r.i}</span>
          <span style={{ font: `500 13px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textSecondary }}>{r.label}</span>
        </div>
      ))}

      <div style={tipCardStyle}>
        <div style={tipGlowStyle} />
        <div style={{ font: `600 11px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.accentCyanSoft }}>◇ REACTOR TIP</div>
        <div style={{ marginTop: 7, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textSecondary }}>
          Parallelize agents off one core to burn fewer tokens per task.
        </div>
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = {
  width: 206,
  flex: 'none',
  padding: '18px 12px',
  borderRight: `1px solid ${colors.chromeBorder}`,
  background: 'rgba(4,15,22,.55)',
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  overflow: 'auto',
};
const sectionLabelStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textDim, padding: '2px 10px 6px' };
function navItemStyle(on: boolean, clickable: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    padding: '9px 10px',
    borderRadius: 9,
    cursor: clickable ? 'pointer' : 'default',
    background: on ? 'linear-gradient(90deg, rgba(23,184,216,.18), rgba(23,184,216,.02))' : undefined,
    border: on ? '1px solid rgba(95,220,255,.4)' : '1px solid transparent',
    color: on ? colors.textPrimary : '#7f9fac',
    boxShadow: on ? 'inset 0 0 14px rgba(95,240,255,.12)' : undefined,
  };
}
function navDotWrapStyle(on: boolean): CSSProperties {
  return {
    width: 20,
    height: 20,
    borderRadius: 6,
    border: `1px solid ${on ? 'rgba(95,220,255,.6)' : 'rgba(80,140,160,.35)'}`,
    display: 'grid',
    placeItems: 'center',
    flex: 'none',
  };
}
function navDotStyle(on: boolean): CSSProperties {
  return { width: 7, height: 7, borderRadius: 2, background: on ? colors.accentCyan : '#3d6572' };
}
const recentRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderRadius: 8 };
function recentAvatarStyle(ring: string): CSSProperties {
  return {
    width: 22,
    height: 22,
    borderRadius: 6,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 4px,#123f4e 4px 8px)',
    border: `1px solid ${ring}`,
    display: 'grid',
    placeItems: 'center',
    font: `700 10px/1 ${fonts.mono}`,
    color: ring,
  };
}
const tipCardStyle: CSSProperties = {
  marginTop: 'auto',
  padding: 13,
  borderRadius: 12,
  border: '1px solid rgba(95,220,255,.25)',
  background: 'linear-gradient(180deg, rgba(14,48,60,.7), rgba(8,26,34,.7))',
  position: 'relative',
  overflow: 'hidden',
};
const tipGlowStyle: CSSProperties = {
  position: 'absolute',
  top: -14,
  right: -14,
  width: 56,
  height: 56,
  borderRadius: '50%',
  background: 'radial-gradient(circle, rgba(95,240,255,.25), transparent 70%)',
  animation: 'breath var(--pulse-dur, 2.4s) ease-in-out infinite',
};
```

- [ ] **Step 3: Implement src/components/layout/Footer.tsx**

Note: "Uptime 3h 42m" is a static string in the source (not derived from session start) — preserved as-is per the Global Constraints note.

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function Footer() {
  const { state } = useAetherStore();
  const c = state.alarmLevel === 'crit' ? colors.danger : state.alarmLevel === 'warn' ? colors.warn : colors.success;
  const label = state.alarmLevel === 'crit' ? 'BURN ALARM' : state.alarmLevel === 'warn' ? 'BURN ELEVATED' : 'ALL GOOD';
  return (
    <div style={rootStyle}>
      <span>◇ AETHER OS v1.0.0</span>
      <span style={{ color: colors.textMuted }}>Reactor draws power on demand — tokens are contained, never wasted.</span>
      <span style={{ marginLeft: 'auto' }}>Uptime 3h 42m</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: c }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: c, boxShadow: `0 0 8px ${c}` }} />
        {label}
      </span>
    </div>
  );
}

const rootStyle: CSSProperties = {
  height: 34,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 18,
  padding: '0 22px',
  borderTop: `1px solid ${colors.chromeBorder}`,
  background: 'rgba(4,16,24,.7)',
  font: `400 11px/1 ${fonts.mono}`,
  color: colors.textDim,
};
```

- [ ] **Step 4: Implement src/components/layout/ComingSoonPanel.tsx**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';

export function ComingSoonPanel({ tabName }: { tabName: string }) {
  return (
    <div style={rootStyle}>
      <div style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textSecondary }}>{tabName.toUpperCase()}</div>
      <div style={{ marginTop: 8, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textMuted }}>
        This view is not built yet — only Terminal is implemented in this pass.
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = {
  flex: 1,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
};
```

- [ ] **Step 5: Implement src/components/layout/AppShell.tsx**

```tsx
import type { CSSProperties, ReactNode } from 'react';
import { colors } from '../../styles/tokens';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { Footer } from './Footer';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div style={pageStyle}>
      <div style={frameStyle}>
        <TopBar />
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <Sidebar />
          <div style={contentStyle}>{children}</div>
        </div>
        <Footer />
      </div>
    </div>
  );
}

const pageStyle: CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: colors.pageRadial,
};
const frameStyle: CSSProperties = { width: 1536, height: 1024, display: 'flex', flexDirection: 'column', overflow: 'hidden' };
const contentStyle: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 };
```

Note: `contentStyle` is `flexDirection: 'column'` because Task 8's `BottomMetricsRow` stacks below the per-tab view inside it — the per-tab view itself (e.g. Terminal's two-column layout) is the first flex child and must set its own `flex: 1, minHeight: 0` so it fills available space above the fixed-height bottom row.

- [ ] **Step 6: Replace src/App.tsx with the real shell**

```tsx
import { AetherStoreProvider, useAetherStore } from './state/store';
import { AppShell } from './components/layout/AppShell';
import { ComingSoonPanel } from './components/layout/ComingSoonPanel';
import { BottomMetricsRow } from './components/layout/BottomMetricsRow';

function ActiveView() {
  const { state } = useAetherStore();
  if (state.activeTab === 'Terminal') {
    // TerminalView is wired in here in Task 10 — for now fall through to ComingSoonPanel
    // so the app has something real to render at every step of this plan.
  }
  return <ComingSoonPanel tabName={state.activeTab} />;
}

export default function App() {
  return (
    <AetherStoreProvider>
      <AppShell>
        <ActiveView />
        <BottomMetricsRow />
      </AppShell>
    </AetherStoreProvider>
  );
}
```

`BottomMetricsRow` doesn't exist until Task 8. To keep this task's dev-server verification working standalone, stub it now:

```tsx
export function BottomMetricsRow() {
  return null;
}
```
(as `src/components/layout/BottomMetricsRow.tsx` — Task 8 replaces this with the real 4-card row.)

- [ ] **Step 7: Verify via the dev server**

Run: `npm run dev`
Expected: the full 1536×1024 frame renders — top bar with logo/tabs/op-mode segmented control/approval shield/notification bell/operator chip, left sidebar with nav + recent agents + reactor tip card, a "TERMINAL — not built yet" panel in the content area, footer with "ALL GOOD" in green. Clicking tabs/nav updates the highlighted state and the panel's label. Clicking the approval shield opens the 2-request dropdown from `initialState`; approving/denying one removes it and the badge count updates.

- [ ] **Step 8: Commit**

```bash
git add src/components/layout src/App.tsx
git commit -m "feat: build shared app chrome — top bar, sidebar, footer, app shell"
```

---

### Task 8: Bottom metrics row (shared cards)

Ported from the source's "BOTTOM METRICS ROW" (lines 1213–1301), which sits **outside** the `isTerminal` conditional in the source — confirming the README's "Bottom row (all views share)" claim. That's why it's wired into `AppShell`/`App.tsx` in Task 7 rather than into `TerminalView`. Derived values (`weekly`, `weekTotal`, `ctxPct`, `ctxDash`, `ctxIn`/`ctxOut`, `session`) are ported from `renderVals()` (lines 2592–2619); `commands` (Top Commands bars) is static demo data in the source (lines 2605–2611) with no live wiring — ported as-is, since building real command-frequency tracking is out of scope for this pass.

**Files:**
- Modify: `src/components/layout/BottomMetricsRow.tsx` (replacing Task 7's `null` stub)

**Interfaces:**
- Consumes: `useAetherStore()`, `fmt` from `../../utils/format`.
- Produces: `BottomMetricsRow()` component, already wired into `App.tsx` by Task 7.

No unit-testable logic beyond `fmt` (already tested in Task 2) — verify via dev server.

- [ ] **Step 1: Implement src/components/layout/BottomMetricsRow.tsx**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { fmt } from '../../utils/format';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TOP_COMMANDS = [
  { n: 1, name: 'build', count: '128×', w: 100 },
  { n: 2, name: 'deploy', count: '84×', w: 66 },
  { n: 3, name: 'analyze', count: '67×', w: 52 },
  { n: 4, name: 'refactor', count: '52×', w: 41 },
  { n: 5, name: 'doc', count: '41×', w: 32 },
];

export function BottomMetricsRow() {
  const { state } = useAetherStore();

  const maxBar = Math.max(...state.weekRaw);
  const weekly = state.weekRaw.map((v, i) => ({ d: DAY_LABELS[i], h: Math.round(20 + (v / maxBar) * 52) }));
  const weekTotal = fmt(327841 + (state.used - 24391));

  const ctxTotal = 125000;
  const ctxPct = Math.round((state.ctxUsed / ctxTotal) * 100);
  const circ = 2 * Math.PI * 42;
  const ctxDash = `${((circ * ctxPct) / 100).toFixed(1)} ${circ.toFixed(1)}`;
  const inTok = Math.round(state.ctxUsed * 0.58);
  const outTok = Math.round(state.ctxUsed * 0.42);

  const session = [
    { k: 'Session start', v: '2:15 PM' },
    { k: 'Uptime', v: '3h 42m' },
    { k: 'Commands run', v: fmt(state.commandsRun) },
    { k: 'Agents active', v: String(state.agents.length) },
    { k: 'Tokens used', v: fmt(state.used) },
  ];

  return (
    <div style={rootStyle}>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={cardTitleStyle}>TOKEN USAGE</div>
          <div style={{ display: 'flex', gap: 4 }}>
            <span style={rangeChipStyle(false)}>LIVE</span>
            <span style={rangeChipStyle(false)}>DAILY</span>
            <span style={rangeChipStyle(true)}>WEEKLY</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 9, height: 74, flex: 1 }}>
            {weekly.map((w) => (
              <div key={w.d} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <div style={barStyle(w.h)} />
                <span style={{ font: `400 9px/1 ${fonts.mono}`, color: colors.textDim }}>{w.d}</span>
              </div>
            ))}
          </div>
          <div style={{ flex: 'none', textAlign: 'right' }}>
            <div style={{ font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted }}>THIS WEEK</div>
            <div style={{ font: `700 24px/1 ${fonts.mono}`, color: colors.textPrimary, marginTop: 6 }}>{weekTotal}</div>
            <div style={{ font: `400 10px/1 ${fonts.mono}`, color: colors.textMuted, marginTop: 4 }}>tokens</div>
            <div style={{ font: `400 11px/1 ${fonts.ui}`, color: colors.success, marginTop: 6 }}>▼ 12% vs last wk</div>
          </div>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>CONTEXT WINDOW</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12 }}>
          <div style={{ position: 'relative', width: 96, height: 96, flex: 'none' }}>
            <svg viewBox="0 0 100 100" style={{ width: 96, height: 96, transform: 'rotate(-90deg)' }}>
              <circle cx={50} cy={50} r={42} fill="none" stroke="rgba(20,50,64,.8)" strokeWidth={9} />
              <circle
                cx={50}
                cy={50}
                r={42}
                fill="none"
                stroke={colors.accentCyanDeep}
                strokeWidth={9}
                strokeLinecap="round"
                strokeDasharray={ctxDash}
                style={{ filter: 'drop-shadow(0 0 4px rgba(95,240,255,.8))', transition: 'stroke-dasharray .5s ease' }}
              />
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
              <div>
                <div style={{ font: `700 22px/1 ${fonts.mono}`, color: colors.textPrimary }}>{ctxPct}%</div>
                <div style={{ font: `400 9px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted, marginTop: 3 }}>USED</div>
              </div>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ font: `700 14px/1 ${fonts.mono}`, color: colors.textBody }}>{fmt(state.ctxUsed)}</div>
            <div style={{ font: `400 10px/1 ${fonts.mono}`, color: colors.textMuted, marginTop: 3 }}>/ 125,000 tokens</div>
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div style={legendRowStyle}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: colors.accentCyanDeep }} />
                Input <span style={{ marginLeft: 'auto', color: colors.textMuted }}>{fmt(inTok)}</span>
              </div>
              <div style={legendRowStyle}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: colors.success }} />
                Output <span style={{ marginLeft: 'auto', color: colors.textMuted }}>{fmt(outTok)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={cardTitleStyle}>TOP COMMANDS</div>
          <div style={{ font: `400 10px/1 ${fonts.mono}`, color: colors.textDim }}>THIS WEEK</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 13 }}>
          {TOP_COMMANDS.map((c) => (
            <div key={c.n} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, width: 12 }}>{c.n}</span>
              <span style={{ font: `600 12px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textBody, width: 58 }}>{c.name}</span>
              <span style={{ flex: 1, height: 5, borderRadius: 3, background: 'rgba(20,50,64,.7)', overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${c.w}%`, background: 'linear-gradient(90deg,#0f7f97,#7ef0ff)', boxShadow: '0 0 8px rgba(95,240,255,.5)' }} />
              </span>
              <span style={{ font: `700 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft, width: 34, textAlign: 'right' }}>{c.count}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>SESSION INFO</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 13 }}>
          {session.map((s) => (
            <div key={s.k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ font: `400 11px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textMuted }}>{s.k}</span>
              <span style={{ font: `700 12px/1 ${fonts.mono}`, color: colors.textBody }}>{s.v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 'none', display: 'grid', gridTemplateColumns: '1.15fr 1fr 1.1fr .95fr', gap: 14 };
const cardStyle: CSSProperties = { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient };
const cardTitleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
function rangeChipStyle(active: boolean): CSSProperties {
  return {
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    padding: '4px 8px',
    borderRadius: 5,
    color: active ? colors.accentCyanSoft : colors.textDim,
    border: active ? '1px solid rgba(95,220,255,.35)' : undefined,
  };
}
function barStyle(h: number): CSSProperties {
  return {
    width: '100%',
    borderRadius: '3px 3px 0 0',
    height: h,
    background: 'linear-gradient(180deg,#7ef0ff,#17b8d8)',
    boxShadow: '0 0 10px rgba(95,240,255,.4)',
    transition: 'height .5s ease',
  };
}
const legendRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, font: `400 11px/1 ${fonts.mono}`, color: colors.textSecondary };
```

- [ ] **Step 2: Verify via the dev server**

Run: `npm run dev`
Expected: below the "TERMINAL — not built yet" panel, a 4-column row appears — weekly token bar chart with a live total, a context-window donut with input/output legend, a top-commands bar list, and session info key/value pairs. All should update their card chrome consistently with the rest of the app (same border/gradient as top-bar dropdowns).

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/BottomMetricsRow.tsx
git commit -m "feat: add the shared bottom metrics row (token usage, context window, top commands, session info)"
```

---

### Task 9: Terminal command dispatch (commands.ts)

Replaces Task 4's stub with the real port of `runCmd()` (lines 2365–2472), `makeAgent()` (lines 2489–2497), and `spawnAgent()`'s auto-name pool (lines 2508–2512). One deliberate fix from the Global Constraints section: the source's `approve`/`deny` handler builds its success line via `cmd.toLowerCase() + 'd'`, which produces `"denyd"` for the deny path (a copy bug) — this port outputs `"denied"` correctly instead.

**Files:**
- Modify: `src/components/terminal/commands.ts` (replacing Task 4's stub)
- Test: `src/components/terminal/commands.test.ts`
- Modify: `src/state/types.ts` (move `CommandResult` here if not already — it was added in Task 4 Step 4b)

**Interfaces:**
- Consumes: `AetherState`, `TermLine`, `CommandResult`, `Agent` from `../../state/types`; `fmt`, `fmtEta` from `../../utils/format`.
- Produces: `runCommand(state: AetherState, raw: string): CommandResult`, `makeAgent(name: string): Agent` — `makeAgent` is also useful standalone for a future `deployAgent`/idle-pool feature, so it's exported.

- [ ] **Step 1: Write the failing tests**

`src/components/terminal/commands.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runCommand } from './commands';
import { initialState } from '../../state/initialState';

describe('runCommand', () => {
  it('help lists every documented command', () => {
    const result = runCommand(initialState, 'help');
    expect(result.kind).toBe('append');
    if (result.kind !== 'append') throw new Error('unreachable');
    const text = result.lines.map((l) => l.t).join('\n');
    ['status', 'agents', 'spawn <name>', 'kill <name>', 'budget', 'projects', 'sweep', 'approvals', 'approve <n>', 'deny <n>', 'theme <name>', 'renderer <mode>', 'clear'].forEach(
      (cmd) => expect(text).toContain(cmd),
    );
  });

  it('unknown command returns an error line, no patch', () => {
    const result = runCommand(initialState, 'frobnicate');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.lines[1].t).toContain('unknown command: frobnicate');
    expect(result.patch).toBeUndefined();
  });

  it('spawn <name> adds a named agent and raises the burn rate by 18000', () => {
    const result = runCommand(initialState, 'spawn Sentinel');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.patch?.agents).toHaveLength(initialState.agents.length + 1);
    expect(result.patch?.agents?.at(-1)?.name).toBe('Sentinel');
    expect(result.patch?.rate).toBe(initialState.rate + 18000);
  });

  it('spawn with no name picks the first unused name from the auto pool', () => {
    const result = runCommand(initialState, 'spawn');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.patch?.agents?.at(-1)?.name).toBe('Image Gen');
  });

  it('kill removes a matching agent case-insensitively and moves it to idleList', () => {
    const result = runCommand(initialState, 'kill code builder');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.patch?.agents?.map((a) => a.name)).not.toContain('Code Builder');
    expect(result.patch?.idleList?.at(-1)).toEqual({ name: 'Code Builder', last: 'just now' });
  });

  it('kill on an unknown agent reports an error with no patch', () => {
    const result = runCommand(initialState, 'kill nobody');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.lines[1].t).toContain('no agent named "nobody"');
    expect(result.patch).toBeUndefined();
  });

  it('theme accepts only the six known names', () => {
    const ok = runCommand(initialState, 'theme violet');
    if (ok.kind !== 'append') throw new Error('unreachable');
    expect(ok.patch?.cfg?.theme).toBe('violet');

    const bad = runCommand(initialState, 'theme plaid');
    if (bad.kind !== 'append') throw new Error('unreachable');
    expect(bad.patch).toBeUndefined();
  });

  it('renderer maps "nebula" to the internal "classic" key', () => {
    const result = runCommand(initialState, 'renderer nebula');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.patch?.cfg?.renderer).toBe('classic');
  });

  it('approve on a HIGH risk request raises the rate by 9000; deny does not, and says "denied" not "denyd"', () => {
    const approve = runCommand(initialState, 'approve 1');
    if (approve.kind !== 'append') throw new Error('unreachable');
    expect(approve.patch?.rate).toBe(initialState.rate + 9000);
    expect(approve.patch?.approvals?.map((a) => a.id)).toEqual([2]);

    const deny = runCommand(initialState, 'deny 2');
    if (deny.kind !== 'append') throw new Error('unreachable');
    expect(deny.patch?.rate).toBe(initialState.rate);
    expect(deny.lines[1].t).toContain('denied');
    expect(deny.lines[1].t).not.toContain('denyd');
  });

  it('approve/deny on an out-of-range index reports an error', () => {
    const result = runCommand(initialState, 'approve 99');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.lines[1].t).toContain('no request [99]');
  });

  it('clear returns the clear variant', () => {
    expect(runCommand(initialState, 'clear')).toEqual({ kind: 'clear' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- commands`
Expected: FAIL — the stub `runCommand` always returns `{ kind: 'append', lines: [] }`.

- [ ] **Step 3: Implement src/components/terminal/commands.ts**

```ts
import type { Agent, AetherState, CommandResult, TermLine, ThemeName, RendererMode } from '../../state/types';
import { fmt, fmtEta } from '../../utils/format';

const PROMPT = '#7fd8ef';
const BODY = '#9fc4d1';
const GOOD = '#3be0a0';
const BAD = '#ff9d9d';
const DIM = '#5f8a97';

function line(t: string, c: string = BODY): TermLine {
  return { t, c };
}

const AGENT_HUES = ['#7ef0ff', '#8ab6ff', '#5fffe0', '#7fd8ef', '#9bd0ff'];

export function makeAgent(name: string): Agent {
  return {
    i: name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase(),
    name,
    task: 'Initializing…',
    pct: 0,
    hue: AGENT_HUES[Math.floor(Math.random() * AGENT_HUES.length)],
    eta: 'calc…',
    share: 0.12 + Math.random() * 0.1,
    hist: [],
    files: [
      { s: '›', n: 'booting runtime…', c: '#4e7c8b' },
      { s: '·', n: 'awaiting mission', c: '#4e7c8b' },
    ],
  };
}

function nextAutoName(state: AetherState): string {
  const pool = ['Image Gen', 'Sentry', 'Doc Writer', 'Optimizer', 'Auditor'];
  const taken = new Set([...state.agents.map((a) => a.name), ...state.idleList.map((x) => x.name)]);
  return pool.find((n) => !taken.has(n)) || `Auxiliary ${state.agents.length + 1}`;
}

const THEME_NAMES: ThemeName[] = ['cyan', 'blue', 'teal', 'violet', 'amber', 'red'];

export function runCommand(state: AetherState, raw: string): CommandResult {
  const trimmed = raw.trim();
  const [cmd, ...args] = trimmed.split(/\s+/);
  const out: TermLine[] = [line(`operator@aether-core:~$ ${trimmed}`, PROMPT)];

  switch ((cmd || '').toLowerCase()) {
    case 'help': {
      out.push(
        line('Available commands:', DIM),
        line('  status              reactor & session summary'),
        line('  agents              list active agents'),
        line('  spawn <name>        spawn a new agent'),
        line('  kill <name>         terminate an agent'),
        line('  budget              token budget & burn'),
        line('  projects            list projects'),
        line('  sweep               run memory consolidation'),
        line('  approvals           list pending authorizations'),
        line('  approve <n>         grant request n'),
        line('  deny <n>            reject request n'),
        line('  theme <name>        cyan|blue|teal|violet|amber|red'),
        line('  renderer <mode>     nebula|volumetric|warp core renderer'),
        line('  clear               clear the terminal'),
      );
      return { kind: 'append', lines: out };
    }

    case 'status': {
      out.push(
        line(`◇ Reactor nominal — ${state.agents.length} agents drawing power`, GOOD),
        line(`  burn rate    ${fmt(state.rate)} tok/min`),
        line(`  session use  ${fmt(state.used)} tokens`),
        line(`  context      ${fmt(state.ctxUsed)} / 125,000`),
      );
      return { kind: 'append', lines: out };
    }

    case 'agents': {
      if (!state.agents.length) out.push(line('  no active agents', DIM));
      state.agents.forEach((a) =>
        out.push(line(`  ${a.i}  ${a.name.padEnd(16)}${Math.round(a.pct)}%  ${a.paused ? 'paused' : 'active'}`, a.paused ? '#f5c66b' : BODY)),
      );
      return { kind: 'append', lines: out };
    }

    case 'spawn': {
      const requested = args.join(' ');
      const agent = makeAgent(requested || nextAutoName(state));
      out.push(line(`✓ ${agent.name} spawned — reactor load increased`, GOOD));
      return {
        kind: 'append',
        lines: out,
        patch: { agents: [...state.agents, agent], rate: Math.min(168000, state.rate + 18000) },
      };
    }

    case 'kill': {
      const name = args.join(' ');
      const hit = state.agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
      if (!hit) {
        out.push(line(`✗ no agent named "${name}"`, BAD));
        return { kind: 'append', lines: out };
      }
      out.push(line(`✓ ${hit.name} terminated — returned to idle pool`, GOOD));
      return {
        kind: 'append',
        lines: out,
        patch: {
          agents: state.agents.filter((a) => a.name !== hit.name),
          idleList: [...state.idleList, { name: hit.name, last: 'just now' }],
        },
      };
    }

    case 'budget': {
      const rem = Math.max(0, state.cfg.capM * 1e6 - state.used);
      out.push(
        line(`  monthly cap  ${state.cfg.capM.toFixed(1)}M tokens`),
        line(`  used         ${fmt(state.used)} ($${(state.used * 0.000018).toFixed(2)})`),
        line(`  remaining    ${fmt(rem)} — depletes in ${fmtEta(rem / (state.rate / 60))}`),
      );
      return { kind: 'append', lines: out };
    }

    case 'projects': {
      if (!state.projects.length) out.push(line('  no projects tracked yet', DIM));
      state.projects.forEach((p) => out.push(line(`  ${p.status.padEnd(9)}${p.name} — ${p.pct}%`, p.status === 'BUILDING' ? PROMPT : BODY)));
      return { kind: 'append', lines: out };
    }

    case 'sweep': {
      const weak = state.memories.filter((m) => !m.pinned && m.strength <= 30).length;
      out.push(line(`✓ consolidation sweep complete — ${weak} weak engrams compacted`, GOOD));
      return { kind: 'append', lines: out, patch: { memories: state.memories.filter((m) => m.pinned || m.strength > 30) } };
    }

    case 'theme': {
      const theme = (args[0] || '').toLowerCase() as ThemeName;
      if (!THEME_NAMES.includes(theme)) {
        out.push(line('✗ unknown theme — try cyan|blue|teal|violet|amber|red', BAD));
        return { kind: 'append', lines: out };
      }
      out.push(line(`✓ reactor theme set to ${theme}`, GOOD));
      return { kind: 'append', lines: out, patch: { cfg: { ...state.cfg, theme } } };
    }

    case 'renderer': {
      const rd = (args[0] || '').toLowerCase();
      if (!['nebula', 'classic', 'volumetric', 'warp'].includes(rd)) {
        out.push(line('✗ usage: renderer nebula|volumetric|warp', BAD));
        return { kind: 'append', lines: out };
      }
      const key: RendererMode = rd === 'nebula' ? 'classic' : (rd as RendererMode);
      const suffix = rd === 'volumetric' ? ' — plasma shader online' : rd === 'warp' ? ' — intermix chamber aligned' : ' — containment field released';
      out.push(line(`✓ core renderer set to ${rd}${suffix}`, GOOD));
      return { kind: 'append', lines: out, patch: { cfg: { ...state.cfg, renderer: key } } };
    }

    case 'approvals': {
      if (!state.approvals.length) out.push(line('  queue clear', DIM));
      state.approvals.forEach((a, i) =>
        out.push(line(`  [${i + 1}] ${a.risk.padEnd(5)}${a.action} — ${a.agent}`, a.risk === 'HIGH' ? BAD : a.risk === 'MED' ? '#f5c66b' : BODY)),
      );
      return { kind: 'append', lines: out };
    }

    case 'approve':
    case 'deny': {
      const n = parseInt(args[0], 10);
      const req = state.approvals[n - 1];
      const approve = cmd.toLowerCase() === 'approve';
      if (!req) {
        out.push(line(`✗ no request [${args[0]}] — run 'approvals'`, BAD));
        return { kind: 'append', lines: out };
      }
      // Deviation from source: the original built this message via `cmd.toLowerCase() + 'd'`,
      // which produces "denyd" for the deny path. This port says "denied" correctly.
      out.push(line(`✓ ${approve ? 'approved' : 'denied'}: ${req.action}`, approve ? GOOD : BAD));
      return {
        kind: 'append',
        lines: out,
        patch: {
          approvals: state.approvals.filter((a) => a.id !== req.id),
          rate: approve && req.risk === 'HIGH' ? Math.min(168000, state.rate + 9000) : state.rate,
        },
      };
    }

    case 'clear':
      return { kind: 'clear' };

    default:
      out.push(line(`✗ unknown command: ${cmd} — type 'help'`, BAD));
      return { kind: 'append', lines: out };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- commands`
Expected: PASS, 12 tests.

- [ ] **Step 5: Run the full suite to confirm Task 4's reducer tests still pass against the real implementation**

Run: `npm test`
Expected: all suites PASS (reducer, tick, persistence, format, tokens, commands).

- [ ] **Step 6: Commit**

```bash
git add src/components/terminal/commands.ts src/components/terminal/commands.test.ts
git commit -m "feat: port terminal command dispatch, fixing the source's denyd typo"
```

---

### Task 10: TerminalView shell (scrollback, input, chips)

Ported from the source's Terminal template (lines 139–256): prompt header, the hard-coded "build my landing page" hero demo (a decorative marketing flourish in the source, not live simulation output), live `termHist`, the command input with the blinking caret, and the suggestion chips. Command history (↑/↓) and submission dispatch to the reducer's `RUN_COMMAND`/`HIST_NAV` actions built in Task 4/9.

One noted gap: the source's exact hard-coded `spawns` array (5 agent names shown as "spawned" in the demo block) wasn't captured verbatim during design-doc extraction — only its shape and the surrounding narrative ("spawning 5 parallel agents…" for a landing-page build) were. The `steps` array (7 build steps with `[ok]` tags) *was* captured verbatim and is ported exactly; `SPAWN_NAMES` below is an original-flavored reconstruction consistent with that narrative, not an extracted value.

The floating reactor core is a static placeholder circle in this task — Task 17 swaps it for the real `<ReactorCore />` once Tasks 12–16 build it. `SystemOverviewCard`/`ActiveAgentsCard`/`LiveOutputCard` are stubbed here (return `null`) so `TerminalView` compiles and the layout can be verified end-to-end; Task 11 fills them in.

**Files:**
- Create: `src/components/terminal/TerminalView.tsx`
- Create (stub, filled in Task 11): `src/components/terminal/SystemOverviewCard.tsx`
- Create (stub, filled in Task 11): `src/components/terminal/ActiveAgentsCard.tsx`
- Create (stub, filled in Task 11): `src/components/terminal/LiveOutputCard.tsx`
- Modify: `src/App.tsx` (render `TerminalView` for the Terminal tab instead of always falling through to `ComingSoonPanel`)

**Interfaces:**
- Consumes: `useAetherStore()`, `dispatch({ type: 'RUN_COMMAND', raw })`, `dispatch({ type: 'SET_CMD_VAL', value })`, `dispatch({ type: 'HIST_NAV', up })` from Task 4/9.
- Produces: `TerminalView()` component. Task 17 imports `ReactorCore` into this file and replaces the placeholder `<div style={coreCircleStyle} />`.

No unit-testable logic here — verify via dev server.

- [ ] **Step 1: Create the three right-rail stub files**

`src/components/terminal/SystemOverviewCard.tsx`, `ActiveAgentsCard.tsx`, `LiveOutputCard.tsx` — each:

```tsx
export function SystemOverviewCard() {
  return null;
}
```

(same pattern for `ActiveAgentsCard`/`LiveOutputCard`, renamed per file.)

- [ ] **Step 2: Implement src/components/terminal/TerminalView.tsx**

```tsx
import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { SystemOverviewCard } from './SystemOverviewCard';
import { ActiveAgentsCard } from './ActiveAgentsCard';
import { LiveOutputCard } from './LiveOutputCard';

const SPAWN_NAMES = ['UI Designer', 'Code Builder', 'Content Writer', 'Test Runner', 'Deploy Bot'];
const BUILD_STEPS = [
  { text: 'Initializing project', tag: '[ok]' },
  { text: 'Analyzing requirements', tag: '[ok]' },
  { text: 'Generating structure', tag: '[ok]' },
  { text: 'Writing code · index.html · styles.css · script.js', tag: '[ok]' },
  { text: 'Optimizing assets', tag: '[ok]' },
  { text: 'Running build', tag: '[ok]' },
  { text: 'Finalizing', tag: '[ok]' },
];
const CHIPS = ['status', 'agents', 'spawn Optimizer', 'budget', 'help'];

export function TerminalView() {
  const { state, dispatch } = useAetherStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.termHist.length]);

  function submit() {
    if (!state.cmdVal.trim()) return;
    dispatch({ type: 'RUN_COMMAND', raw: state.cmdVal });
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') submit();
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      dispatch({ type: 'HIST_NAV', up: true });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      dispatch({ type: 'HIST_NAV', up: false });
    }
  }

  return (
    <div style={rootStyle}>
      <div style={terminalCardStyle}>
        <div style={scanSweepStyle} />
        <div style={headerStyle}>
          <span style={liveDotStyle} />
          <span style={{ font: `400 13px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>operator@aether-core</span>
          <span style={{ font: `400 13px/1 ${fonts.mono}`, color: colors.textDim }}>:~$ session active</span>
          <span style={{ marginLeft: 'auto', font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>TERMINAL · zsh</span>
        </div>

        <div ref={scrollRef} style={scrollbackStyle}>
          <div style={{ color: colors.textSecondary }}>Welcome back, operator. Reactor is online.</div>
          <div style={{ color: colors.textMuted }}>
            Type <span style={{ color: colors.accentCyanSoft }}>'help'</span> for available commands.
          </div>
          <div style={{ height: 12 }} />
          <div>
            <span style={{ color: colors.accentCyanSoft }}>operator@aether-core</span>
            <span style={{ color: colors.textMuted }}>:~$</span> <span style={{ color: colors.textBody }}>build my landing page</span>
          </div>
          <div style={{ color: colors.accentCyanSoft, marginTop: 4 }}>◇ Reactor spun up — spawning 5 parallel agents…</div>
          {SPAWN_NAMES.map((n) => (
            <div key={n}>
              <span style={{ color: colors.textMuted }}>&gt;</span> <span style={{ color: colors.textBody }}>{n}</span>{' '}
              <span style={{ color: colors.success, marginLeft: 16 }}>spawned</span>
            </div>
          ))}
          <div style={{ height: 6 }} />
          {BUILD_STEPS.map((s) => (
            <div key={s.text} style={{ color: colors.textSecondary }}>
              <span style={{ color: colors.success }}>✓</span> {s.text} <span style={{ color: colors.textDim }}>{s.tag}</span>
            </div>
          ))}
          <div style={{ height: 8 }} />
          <div style={{ color: colors.success }}>✓ Build complete — site is live.</div>
          <div style={{ color: colors.textSecondary }}>
            Preview: <a href="#">http://localhost:3000</a>
          </div>
          <div style={{ height: 8 }} />
          {state.termHist.map((th, idx) => (
            <div key={idx} style={{ whiteSpace: 'pre-wrap', color: th.c }}>
              {th.t}
            </div>
          ))}
          <div>
            <span style={{ color: colors.accentCyanSoft }}>operator@aether-core</span>
            <span style={{ color: colors.textMuted }}>:~$</span> <span style={caretStyle} />
          </div>
        </div>

        <div style={coreFloatWrapStyle}>
          {/* Task 17 replaces this placeholder with <ReactorCore /> */}
          <div style={coreCircleStyle} />
        </div>
        <div style={calloutStyle}>Reactor nominal — {state.agents.length} agents drawing power.</div>

        <div style={inputBarStyle}>
          <div style={inputRowStyle}>
            <span style={{ color: colors.accentCyanSoft, font: `700 15px/1 ${fonts.mono}` }}>&gt;</span>
            <input
              value={state.cmdVal}
              onChange={(e) => dispatch({ type: 'SET_CMD_VAL', value: e.target.value })}
              onKeyDown={onKeyDown}
              placeholder="Type a command — try 'help'"
              spellCheck={false}
              style={inputStyle}
            />
            <span onClick={submit} style={sendButtonStyle}>
              ➤
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 11, flexWrap: 'wrap' }}>
            {CHIPS.map((c) => (
              <div key={c} onClick={() => dispatch({ type: 'RUN_COMMAND', raw: c })} style={chipStyle}>
                {c}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={railStyle}>
        <SystemOverviewCard />
        <ActiveAgentsCard />
        <LiveOutputCard />
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
const terminalCardStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  position: 'relative',
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};
const scanSweepStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  height: 150,
  background: 'linear-gradient(180deg, rgba(95,240,255,.08), transparent)',
  animation: 'scan 7s linear infinite',
  pointerEvents: 'none',
};
const headerStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '11px 16px',
  borderBottom: `1px solid ${colors.chromeBorder}`,
};
const liveDotStyle: CSSProperties = { width: 10, height: 10, borderRadius: '50%', background: colors.accentCyanDeep, boxShadow: '0 0 8px rgba(95,240,255,.8)' };
const scrollbackStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', padding: '16px 20px', font: `400 13px/1.8 ${fonts.mono}`, position: 'relative' };
const caretStyle: CSSProperties = {
  width: 9,
  height: 16,
  display: 'inline-block',
  background: colors.accentCyan,
  verticalAlign: -2,
  marginLeft: 4,
  animation: 'blink 1s step-end infinite',
};
const coreFloatWrapStyle: CSSProperties = {
  position: 'absolute',
  right: 6,
  top: '52%',
  transform: 'translateY(-50%)',
  width: 334,
  height: 334,
  display: 'grid',
  placeItems: 'center',
  pointerEvents: 'none',
};
const coreCircleStyle: CSSProperties = {
  width: 224,
  height: 224,
  borderRadius: '50%',
  border: '1px solid rgba(95,220,255,.25)',
  background: 'radial-gradient(circle, rgba(23,184,216,.15), transparent 70%)',
};
const calloutStyle: CSSProperties = {
  position: 'absolute',
  right: 100,
  top: 'calc(52% + 176px)',
  padding: '9px 13px',
  borderRadius: '2px 10px 10px 10px',
  border: '1px solid rgba(95,220,255,.3)',
  background: 'rgba(10,34,45,.9)',
  font: `400 12px/1.4 ${fonts.ui}`,
  color: '#bff4ff',
  maxWidth: 146,
  textAlign: 'left',
};
const inputBarStyle: CSSProperties = { flex: 'none', padding: '13px 16px', borderTop: `1px solid ${colors.chromeBorder}` };
const inputRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderRadius: 10,
  border: '1px solid rgba(80,190,220,.3)',
  background: 'rgba(6,20,28,.7)',
};
const inputStyle: CSSProperties = {
  flex: 1,
  font: `400 13px/1 ${fonts.mono}`,
  color: colors.textBody,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  caretColor: colors.accentCyan,
};
const sendButtonStyle: CSSProperties = {
  cursor: 'pointer',
  width: 30,
  height: 30,
  borderRadius: 8,
  background: 'linear-gradient(180deg,#17b8d8,#0f7f97)',
  display: 'grid',
  placeItems: 'center',
  color: colors.textPrimary,
  boxShadow: '0 0 14px rgba(95,240,255,.5)',
};
const chipStyle: CSSProperties = {
  cursor: 'pointer',
  padding: '6px 13px',
  borderRadius: 7,
  border: '1px solid rgba(80,190,220,.25)',
  background: 'rgba(10,32,43,.5)',
  font: `400 12px/1 ${fonts.mono}`,
  color: colors.textSecondary,
};
const railStyle: CSSProperties = { width: 332, flex: 'none', display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 };
```

- [ ] **Step 3: Wire TerminalView into App.tsx**

```tsx
import { AetherStoreProvider, useAetherStore } from './state/store';
import { AppShell } from './components/layout/AppShell';
import { ComingSoonPanel } from './components/layout/ComingSoonPanel';
import { BottomMetricsRow } from './components/layout/BottomMetricsRow';
import { TerminalView } from './components/terminal/TerminalView';

function ActiveView() {
  const { state } = useAetherStore();
  if (state.activeTab === 'Terminal') return <TerminalView />;
  return <ComingSoonPanel tabName={state.activeTab} />;
}

export default function App() {
  return (
    <AetherStoreProvider>
      <AppShell>
        <ActiveView />
        <BottomMetricsRow />
      </AppShell>
    </AetherStoreProvider>
  );
}
```

- [ ] **Step 4: Verify via the dev server**

Run: `npm run dev`
Expected: the Terminal tab (default on load) shows the prompt header, the "build my landing page" demo transcript, a placeholder core circle floating right with its callout bubble below it, and a working command input. Type `help` and press Enter — a command list appears in the scrollback and the input clears. Press ↑ — the input fills with `help` again. Click the `status` chip — a status block appears. Type `clear` — the live transcript (not the hard-coded demo above it) empties.

- [ ] **Step 5: Commit**

```bash
git add src/components/terminal/TerminalView.tsx src/components/terminal/SystemOverviewCard.tsx src/components/terminal/ActiveAgentsCard.tsx src/components/terminal/LiveOutputCard.tsx src/App.tsx
git commit -m "feat: build the Terminal view shell — scrollback, command input, history nav, chips"
```

---

### Task 11: Terminal right rail (System Overview, Active Agents, Live Output)

Replaces Task 10's three `null` stubs with the real cards, ported from the Terminal template's right-rail markup. "SPAWN +" dispatches `RUN_COMMAND` with `raw: 'spawn'`, reusing the exact same code path as typing `spawn` in the terminal rather than adding a parallel action — one source of truth for "spawn an agent." Live Output shows the last 8 log lines per the source (`logs: s.logs.slice(-8)`, from `renderVals()`).

**Files:**
- Modify: `src/components/terminal/SystemOverviewCard.tsx`
- Modify: `src/components/terminal/ActiveAgentsCard.tsx`
- Modify: `src/components/terminal/LiveOutputCard.tsx`

**Interfaces:**
- Consumes: `useAetherStore()`; `spark` from `../../utils/format`.

No unit-testable logic (pure presentation over already-tested `spark`) — verify via dev server.

- [ ] **Step 1: Implement src/components/terminal/SystemOverviewCard.tsx**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { spark } from '../../utils/format';

export function SystemOverviewCard() {
  const { state } = useAetherStore();
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>SYSTEM OVERVIEW</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 11px/1 ${fonts.mono}`, color: colors.success }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: colors.success, boxShadow: '0 0 8px rgba(59,224,160,.8)' }} />
          NOMINAL
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 13 }}>
        {state.sys.map((m) => (
          <div key={m.label} style={metricTileStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted }}>{m.label}</span>
              <span style={{ font: `700 15px/1 ${fonts.mono}`, color: colors.textBody }}>{Math.round(m.val)}%</span>
            </div>
            <svg viewBox="0 0 62 22" preserveAspectRatio="none" style={{ width: '100%', height: 22, marginTop: 7, display: 'block' }}>
              <polyline
                points={spark(m.hist)}
                fill="none"
                stroke={colors.accentCyanDeep}
                strokeWidth={1.4}
                strokeLinejoin="round"
                style={{ filter: 'drop-shadow(0 0 3px rgba(95,240,255,.7))' }}
              />
            </svg>
          </div>
        ))}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { flex: 'none', padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient };
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const metricTileStyle: CSSProperties = { padding: '10px 12px', borderRadius: 9, border: '1px solid rgba(80,190,220,.16)', background: 'rgba(6,20,28,.5)' };
```

- [ ] **Step 2: Implement src/components/terminal/ActiveAgentsCard.tsx**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function ActiveAgentsCard() {
  const { state, dispatch } = useAetherStore();
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flex: 'none' }}>
        <div style={titleStyle}>ACTIVE AGENTS</div>
        <div onClick={() => dispatch({ type: 'RUN_COMMAND', raw: 'spawn' })} style={spawnButtonStyle}>
          SPAWN +
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 13 }}>
        {state.agents.map((a) => (
          <div key={a.name} onClick={() => dispatch({ type: 'SELECT_AGENT', name: a.name })} style={{ display: 'flex', alignItems: 'center', gap: 11, cursor: 'pointer' }}>
            <span style={avatarStyle(a.hue)}>{a.i}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textPrimary }}>{a.name}</span>
                <span style={{ font: `700 12px/1 ${fonts.mono}`, color: a.hue }}>{Math.round(a.pct)}%</span>
              </div>
              <div style={taskStyle}>{a.task}</div>
              <div style={trackStyle}>
                <div style={fillStyle(a.pct, a.hue)} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  padding: 15,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
};
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const spawnButtonStyle: CSSProperties = {
  cursor: 'pointer',
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: 1,
  color: colors.accentCyanSoft,
  padding: '4px 9px',
  borderRadius: 6,
  border: '1px solid rgba(95,220,255,.35)',
};
function avatarStyle(hue: string): CSSProperties {
  return {
    width: 34,
    height: 34,
    flex: 'none',
    borderRadius: 8,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 5px,#123f4e 5px 10px)',
    border: `1px solid ${hue}`,
    display: 'grid',
    placeItems: 'center',
    font: `700 12px/1 ${fonts.mono}`,
    color: hue,
  };
}
const taskStyle: CSSProperties = {
  font: `400 11px/1 ${fonts.ui}`,
  color: colors.textMuted,
  margin: '4px 0 6px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const trackStyle: CSSProperties = { height: 4, borderRadius: 2, background: 'rgba(20,50,64,.7)', overflow: 'hidden' };
function fillStyle(pct: number, hue: string): CSSProperties {
  return { height: '100%', width: `${pct}%`, background: hue, boxShadow: `0 0 10px ${hue}`, transition: 'width .5s ease' };
}
```

- [ ] **Step 3: Implement src/components/terminal/LiveOutputCard.tsx**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function LiveOutputCard() {
  const { state } = useAetherStore();
  const logs = state.logs.slice(-8);
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flex: 'none' }}>
        <div style={titleStyle}>LIVE OUTPUT</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 10px/1 ${fonts.mono}`, color: colors.accentCyan }}>
          <span style={blinkDotStyle} />
          STREAMING
        </div>
      </div>
      <div style={logListStyle}>
        {logs.map((l, idx) => (
          <div key={idx} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ color: colors.textDim }}>[{l.t}]</span> <span style={{ color: l.c }}>{l.m}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  flex: 'none',
  height: 152,
  padding: '12px 15px',
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
};
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const blinkDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: colors.accentCyan,
  boxShadow: '0 0 8px rgba(126,240,255,.9)',
  animation: 'blink 1.2s step-end infinite',
};
const logListStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
  marginTop: 7,
  font: `400 10.5px/1.7 ${fonts.mono}`,
};
```

- [ ] **Step 4: Verify via the dev server**

Run: `npm run dev`
Expected: the right rail shows 4 CPU/MEM/NET/DISK sparkline tiles that visibly redraw every ~900ms, 5 agent rows with colored progress bars that creep upward, and (once any log lines exist — trigger one by typing `spawn` or waiting for a tick to roll a random log line) a "LIVE OUTPUT" feed bottom-aligned inside its fixed-height card. Clicking "SPAWN +" adds a 6th agent row. Clicking an agent row sets `state.selected` (no visible UI reacts to this yet — the detail slide-over is out of scope for this pass, confirm via React DevTools or a temporary `console.log`).

- [ ] **Step 5: Commit**

```bash
git add src/components/terminal/SystemOverviewCard.tsx src/components/terminal/ActiveAgentsCard.tsx src/components/terminal/LiveOutputCard.tsx
git commit -m "feat: build the Terminal right rail — system overview, active agents, live output"
```

---

### Task 12: Reactor core shell — canvases, rAF loop, watchdog, pulse/theme math

Ported from the source's `applyPulse()` (lines 1758–1764), the hue-rotate theme mapping embedded in `drawCore()` (lines 1846–1852), and the phase/surge computation at the top of `drawCore()` (lines 1855–1862) — these three pieces are extracted into pure, unit-tested functions in `reactorMath.ts`. The `rAF` loop + stall watchdog (`startCore()` lines 1766–1773, watchdog check at line 1647, self-healing check in `componentDidUpdate`) are ported into `useReactorCanvas`, a hook owning three canvas refs matching the source's three-canvas stack (`data-reactor-core`, `data-reactor-gl`, `data-reactor-conduits`).

One documented deviation from the Global Constraints section: the source ties its watchdog to the app-wide 900ms state tick (because everything lived in one class component); this port's watchdog is a `setInterval` local to `useReactorCanvas` itself. Same 2-second stall threshold, same "force one draw + restart the loop" recovery — just self-contained instead of coupled to unrelated app state.

This task's `ReactorCore` only clears the canvases each frame — Tasks 13–16 add the actual NEBULA/VOLUMETRIC/WARP drawing, composed together in Task 17.

**Files:**
- Create: `src/components/reactor/reactorMath.ts`
- Test: `src/components/reactor/reactorMath.test.ts`
- Create: `src/components/reactor/useReactorCanvas.ts`
- Create: `src/components/reactor/ReactorCore.tsx`

**Interfaces:**
- Consumes: `useAetherStore()` from `../../state/store`; `ThemeName`, `AlarmLevel` from `../../state/types`.
- Produces: `computePulseDuration`, `computeThemeHueDeg`, `computeThemeFilter`, `advancePhase`, `computeSurge` from `reactorMath.ts` (Task 13–16 draw functions import `ReactorFrame` from `useReactorCanvas.ts` for their parameter shape); `useReactorCanvas(draw: (frame: ReactorFrame) => void): { coreRef, glRef, conduitRef }`; `ReactorCore()` component — Task 17 imports this into `TerminalView`.

- [ ] **Step 1: Write the failing tests for reactorMath.ts**

`src/components/reactor/reactorMath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { advancePhase, computePulseDuration, computeSurge, computeThemeFilter, computeThemeHueDeg } from './reactorMath';

describe('computePulseDuration', () => {
  it('shortens as burn rate rises in live mode', () => {
    const low = computePulseDuration(28000, 'live', 'ok');
    const high = computePulseDuration(168000, 'live', 'ok');
    expect(low).toBeCloseTo(2.9, 5);
    expect(high).toBeCloseTo(0.8, 5);
    expect(high).toBeLessThan(low);
  });

  it('ambient mode ignores rate and stays at 2.4s', () => {
    expect(computePulseDuration(28000, 'ambient', 'ok')).toBe(2.4);
    expect(computePulseDuration(168000, 'ambient', 'ok')).toBe(2.4);
  });

  it('crit alarm clamps duration to at most 1.0s even in ambient mode logic paths', () => {
    expect(computePulseDuration(28000, 'live', 'crit')).toBeLessThanOrEqual(1.0);
  });
});

describe('computeThemeHueDeg', () => {
  it('maps each theme name to its degree offset', () => {
    expect(computeThemeHueDeg('cyan', 'ok')).toBe(0);
    expect(computeThemeHueDeg('blue', 'ok')).toBe(30);
    expect(computeThemeHueDeg('teal', 'ok')).toBe(-25);
    expect(computeThemeHueDeg('violet', 'ok')).toBe(75);
    expect(computeThemeHueDeg('amber', 'ok')).toBe(-150);
    expect(computeThemeHueDeg('red', 'ok')).toBe(165);
  });

  it('alarm level overrides the chosen theme', () => {
    expect(computeThemeHueDeg('cyan', 'warn')).toBe(-150);
    expect(computeThemeHueDeg('violet', 'crit')).toBe(165);
  });
});

describe('computeThemeFilter', () => {
  it('builds a hue-rotate string, appending desaturation when glowFx is off', () => {
    expect(computeThemeFilter('cyan', 'ok', true)).toBe('hue-rotate(0deg)');
    expect(computeThemeFilter('cyan', 'ok', false)).toBe('hue-rotate(0deg) saturate(.75) brightness(.92)');
  });
});

describe('advancePhase', () => {
  it('advances by dt/duration and wraps past 1', () => {
    expect(advancePhase(0, 1, 2)).toBeCloseTo(0.5, 5);
    expect(advancePhase(0.9, 0.5, 1)).toBeCloseTo(0.4, 5);
  });
});

describe('computeSurge', () => {
  it('is 1 at phase 0 and decays monotonically', () => {
    expect(computeSurge(0)).toBe(1);
    expect(computeSurge(0.5)).toBeLessThan(computeSurge(0.1));
    expect(computeSurge(1)).toBeLessThan(computeSurge(0.5));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- reactorMath`
Expected: FAIL — `reactorMath.ts` doesn't exist yet.

- [ ] **Step 3: Implement src/components/reactor/reactorMath.ts**

```ts
import type { AlarmLevel, ThemeName } from '../../state/types';

const HUE_MAP: Record<ThemeName, number> = { cyan: 0, blue: 30, teal: -25, violet: 75, amber: -150, red: 165 };

export function computePulseDuration(rate: number, pulseMode: 'live' | 'ambient', alarmLevel: AlarmLevel): number {
  const t = (rate - 28000) / (168000 - 28000);
  let dur = pulseMode === 'ambient' ? 2.4 : 2.9 - t * 2.1;
  if (alarmLevel === 'crit') dur = Math.min(dur, 1.0);
  return dur;
}

export function computeThemeHueDeg(theme: ThemeName, alarmLevel: AlarmLevel): number {
  let hueDeg = HUE_MAP[theme] ?? 0;
  if (alarmLevel === 'warn') hueDeg = -150;
  else if (alarmLevel === 'crit') hueDeg = 165;
  return hueDeg;
}

export function computeThemeFilter(theme: ThemeName, alarmLevel: AlarmLevel, glowFx: boolean): string {
  const hueDeg = computeThemeHueDeg(theme, alarmLevel);
  return `hue-rotate(${hueDeg}deg)` + (glowFx === false ? ' saturate(.75) brightness(.92)' : '');
}

export function advancePhase(prevPhase: number, dtSeconds: number, durSeconds: number): number {
  return (prevPhase + dtSeconds / (durSeconds || 2.4)) % 1;
}

export function computeSurge(phase: number): number {
  return Math.exp(-3.5 * phase);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- reactorMath`
Expected: PASS, 8 tests.

- [ ] **Step 5: Implement src/components/reactor/useReactorCanvas.ts**

```ts
import { useEffect, useRef } from 'react';
import { useAetherStore } from '../../state/store';
import { advancePhase, computePulseDuration, computeSurge, computeThemeFilter } from './reactorMath';

export interface ReactorFrame {
  now: number;
  t: number;
  dt: number;
  phase: number;
  surge: number;
  overdrive: boolean;
  glowFactor: number;
  coreCtx: CanvasRenderingContext2D;
  glCanvas: HTMLCanvasElement;
  conduitCtx: CanvasRenderingContext2D;
}

export function useReactorCanvas(draw: (frame: ReactorFrame) => void) {
  const { state } = useAetherStore();
  const coreRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const conduitRef = useRef<HTMLCanvasElement>(null);

  const rafRef = useRef<number>();
  const lastDrawRef = useRef(0);
  const lastTRef = useRef<number>();
  const phaseRef = useRef(0);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const dur = computePulseDuration(state.rate, state.cfg.pulseMode, state.alarmLevel);
    document.documentElement.style.setProperty('--pulse-dur', `${dur.toFixed(2)}s`);
  }, [state.rate, state.cfg.pulseMode, state.alarmLevel]);

  useEffect(() => {
    let cancelled = false;

    function runFrame(now: number) {
      if (cancelled) return;
      const s = stateRef.current;
      const coreEl = coreRef.current;
      const glEl = glRef.current;
      const conduitEl = conduitRef.current;
      if (coreEl && glEl && conduitEl) {
        const dur = computePulseDuration(s.rate, s.cfg.pulseMode, s.alarmLevel);
        const t = now / 1000;
        const dt = Math.min(0.1, t - (lastTRef.current ?? t));
        lastTRef.current = t;
        phaseRef.current = advancePhase(phaseRef.current, dt, dur);
        const phase = phaseRef.current;
        const surge = computeSurge(phase);
        const overdrive = s.agents.length >= 7;
        const glowFactor = (s.cfg.glow == null ? 70 : s.cfg.glow) / 70;
        const themeFilter = computeThemeFilter(s.cfg.theme, s.alarmLevel, s.cfg.glowFx);
        [coreEl, glEl, conduitEl].forEach((el) => {
          if (el.style.filter !== themeFilter) el.style.filter = themeFilter;
        });
        const coreCtx = coreEl.getContext('2d');
        const conduitCtx = conduitEl.getContext('2d');
        if (coreCtx && conduitCtx) {
          drawRef.current({ now, t, dt, phase, surge, overdrive, glowFactor, coreCtx, glCanvas: glEl, conduitCtx });
        }
      }
      lastDrawRef.current = Date.now();
      rafRef.current = requestAnimationFrame(runFrame);
    }

    rafRef.current = requestAnimationFrame(runFrame);

    // Stall watchdog: if the rAF loop hasn't drawn in 2s (backgrounded/throttled tab),
    // force one draw and restart the loop — mirrors the source's tick-driven watchdog.
    const watchdog = setInterval(() => {
      if (Date.now() - lastDrawRef.current > 2000) {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        runFrame(performance.now());
      }
    }, 900);

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      clearInterval(watchdog);
    };
  }, []);

  return { coreRef, glRef, conduitRef };
}
```

- [ ] **Step 6: Implement src/components/reactor/ReactorCore.tsx**

```tsx
import type { CSSProperties } from 'react';
import { useReactorCanvas } from './useReactorCanvas';

export function ReactorCore() {
  const { coreRef, glRef, conduitRef } = useReactorCanvas((frame) => {
    frame.coreCtx.setTransform(1, 0, 0, 1, 0, 0);
    frame.coreCtx.clearRect(0, 0, 448, 448);
    frame.conduitCtx.setTransform(1, 0, 0, 1, 0, 0);
    frame.conduitCtx.clearRect(0, 0, 668, 668);
  });

  return (
    <>
      <canvas ref={conduitRef} width={668} height={668} style={conduitCanvasStyle} />
      <canvas ref={glRef} width={448} height={448} style={{ ...glCanvasStyle, display: 'none' }} />
      <canvas ref={coreRef} width={448} height={448} style={coreCanvasStyle} />
    </>
  );
}

const conduitCanvasStyle: CSSProperties = { position: 'absolute', inset: 0, width: 334, height: 334 };
const glCanvasStyle: CSSProperties = { position: 'absolute', width: 224, height: 224 };
const coreCanvasStyle: CSSProperties = { position: 'relative', width: 224, height: 224, display: 'block' };
```

- [ ] **Step 7: Verify it mounts and runs without error**

`ReactorCore` isn't wired into `TerminalView` until Task 17 (it needs the real drawing logic from Tasks 13–16 first, or it'll just be an invisible clear-loop). Temporarily mount it to smoke-test the hook:

In `src/App.tsx`, temporarily add `import { ReactorCore } from './components/reactor/ReactorCore';` and render `<ReactorCore />` anywhere inside `<AppShell>`. Run `npm run dev`, open devtools console.
Expected: no errors, no infinite-loop warnings. Three canvas elements exist in the DOM (inspect via Elements panel) sized 448×448 with 224×224/334×334 CSS sizes. Revert this temporary import/render before committing — Task 17 does it for real.

- [ ] **Step 8: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS, 0 type errors.

- [ ] **Step 9: Commit**

```bash
git add src/components/reactor/reactorMath.ts src/components/reactor/reactorMath.test.ts src/components/reactor/useReactorCanvas.ts src/components/reactor/ReactorCore.tsx
git commit -m "feat: add reactor core shell — canvases, rAF loop with stall watchdog, pulse/theme math"
```

---

### Task 13: WebGL shader (NEBULA / VOLUMETRIC plasma)

Ported verbatim from the source's `initGL()` (lines 1775–1816) and `drawCoreGL()` (lines 1818–1840) — a fullscreen-triangle fragment shader doing 5-octave FBM (fractal Brownian motion) noise to render a plasma "storm" with a deep-navy→teal→near-white color ramp, a bright core hotspot, an expanding ring wave synced to pulse phase, and a rim highlight. `u_soft` switches between NEBULA's soft radial falloff and VOLUMETRIC's hard circular clip at `r > 0.68` (the housing boundary drawn on top in Task 15).

jsdom has no WebGL implementation, so this module has no automated tests — it's verified visually in Task 17 once it's composed into `ReactorCore`.

**Files:**
- Create: `src/components/reactor/glShader.ts`

**Interfaces:**
- Produces: `initGL(canvas: HTMLCanvasElement): GLProgram | null` (returns `null` on any WebGL init/link failure — Task 17 uses this to fall back to the 2D-only housing path, mirroring the source's `this.glFail` flag), `drawCoreGL(program: GLProgram, params): void`.

- [ ] **Step 1: Implement src/components/reactor/glShader.ts**

```ts
export interface GLProgram {
  gl: WebGLRenderingContext;
  u: Record<string, WebGLUniformLocation | null>;
}

const VERTEX_SHADER = 'attribute vec2 a;varying vec2 v;void main(){v=a;gl_Position=vec4(a,0.,1.);}';

const FRAGMENT_SHADER =
  'precision mediump float;varying vec2 v;uniform float u_t,u_surge,u_phase,u_glow,u_storm,u_od,u_soft,u_grow;' +
  'float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}' +
  'float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),f.x),f.y);}' +
  'float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*n(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return s;}' +
  'void main(){vec2 uv=v;float r=length(uv);' +
  'float lim=u_soft>.5?.985:.68;if(r>lim){gl_FragColor=vec4(0.);return;}' +
  'float t=u_t*.22;' +
  'vec2 q=vec2(fbm(uv*3.+vec2(t,0.)),fbm(uv*3.-vec2(0.,t*1.3)));' +
  'float m=fbm(uv*(3.6+u_od)+q*(1.6+u_od*.6)+vec2(t*2.2,-t*1.1));' +
  'float storm=pow(m,2.3-u_storm)*(.5+.85*u_surge);' +
  'vec3 deep=vec3(.015,.12,.18),mid=vec3(.14,.62,.83),hot=vec3(.78,.97,1.);' +
  'vec3 col=mix(deep,mid,clamp(storm*1.7,0.,1.));' +
  'col=mix(col,hot,pow(max(storm-.32,0.)*1.7,1.7));' +
  'col+=vec3(1.)*exp(-r*r*13.)*(.5+.5*u_surge);' +
  'float wr=.05+u_phase*.66;' +
  'col+=vec3(.8,.98,1.)*exp(-pow((r-wr)*24.,2.))*(1.-u_phase)*.85;' +
  'col+=vec3(.5,.9,1.)*smoothstep(.035,.0,abs(r-.65))*(.3+.7*u_surge)*(1.-u_soft);' +
  'col*=u_glow;' +
  'float a=u_soft>.5?exp(-pow(r/(.34+.30*u_grow),2.)*2.2):smoothstep(.68,.63,r);' +
  'gl_FragColor=vec4(col*a,a);}';

export function initGL(el: HTMLCanvasElement): GLProgram | null {
  const gl = el.getContext('webgl', { alpha: true, premultipliedAlpha: true });
  if (!gl) return null;
  const mk = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, mk(gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, 448, 448);
  const u: Record<string, WebGLUniformLocation | null> = {};
  ['u_t', 'u_surge', 'u_phase', 'u_glow', 'u_storm', 'u_od', 'u_soft', 'u_grow'].forEach((k) => {
    u[k] = gl.getUniformLocation(prog, k);
  });
  return { gl, u };
}

export interface DrawCoreGLParams {
  t: number;
  surge: number;
  phase: number;
  overdrive: boolean;
  glowFactor: number;
  burnRate: number;
  soft: boolean;
}

export function drawCoreGL(program: GLProgram, params: DrawCoreGLParams): void {
  const { gl, u } = program;
  const burnT = Math.max(0, Math.min(1, (params.burnRate - 28000) / 140000));
  gl.uniform1f(u.u_t, params.t);
  gl.uniform1f(u.u_surge, params.surge);
  gl.uniform1f(u.u_phase, params.phase);
  gl.uniform1f(u.u_glow, 0.75 + params.glowFactor * 0.5);
  gl.uniform1f(u.u_storm, 0.25 + burnT * 0.65);
  gl.uniform1f(u.u_od, params.overdrive ? 1 : 0);
  gl.uniform1f(u.u_soft, params.soft ? 1 : 0);
  gl.uniform1f(u.u_grow, Math.min(1, params.surge * 0.7 + burnT * 0.5 + (params.overdrive ? 0.25 : 0)));
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0. (No runtime verification possible outside a real browser WebGL context — deferred to Task 17.)

- [ ] **Step 3: Commit**

```bash
git add src/components/reactor/glShader.ts
git commit -m "feat: port the FBM plasma WebGL shader for NEBULA/VOLUMETRIC reactor renderers"
```

---

### Task 14: Conduits canvas draw

Ported verbatim from the source's `drawConduits(t, surge, p, glowF, themeFilter, hr0, cw)` (lines 2170–2260) — draws 4 directional power channels (right/left/down/up) radiating from the core to the housing rim: a dark trough with wall-line strokes and an end socket, drifting plasma wisps, a bright "pulse packet" riding the channel position, a fading trail behind it, occasional micro-lightning, and an arrival flash when the packet reaches the rim. Used by both VOLUMETRIC (`hubRadius` unset, docks at the housing ring) and WARP (`hubRadius: 48`, docks into the warp hub) — NEBULA never calls this (its branch clears the conduits canvas instead, ported in Task 17).

Theme-filter application to the canvas element is already handled centrally by `useReactorCanvas` (Task 12), so this function only draws — it doesn't touch `canvas.style.filter` the way the source's version did.

No automated tests (imperative canvas drawing) — verified visually in Task 17.

**Files:**
- Create: `src/components/reactor/drawConduits.ts`

**Interfaces:**
- Consumes: a `CanvasRenderingContext2D` for the conduits canvas (from `ReactorFrame.conduitCtx`, Task 12).
- Produces: `drawConduits(ctx, params: DrawConduitsParams): void` — called from Task 17's `ReactorCore` frame callback for VOLUMETRIC and WARP.

- [ ] **Step 1: Implement src/components/reactor/drawConduits.ts**

```ts
export interface DrawConduitsParams {
  t: number;
  surge: number;
  phase: number;
  glowFactor: number;
  hubRadius?: number;
  channelWidth?: number;
}

export function drawConduits(ctx: CanvasRenderingContext2D, params: DrawConduitsParams): void {
  const { t, surge, phase: p, glowFactor: glowF } = params;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, 668, 668);
  ctx.setTransform(2, 0, 0, 2, 0, 0);

  const TAU = Math.PI * 2;
  const c = 167;
  const r1 = 164;
  const w = params.channelWidth || 7;
  const hr0 = params.hubRadius;
  const dirs: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  let g: CanvasGradient;

  dirs.forEach((d, di) => {
    const dx = d[0];
    const dy = d[1];
    const qx = -dy;
    const qy = dx;
    const r0 = dx !== 0 && hr0 ? hr0 : 110;
    const px = (s: number) => c + dx * (r0 + (r1 - r0) * s);
    const py = (s: number) => c + dy * (r0 + (r1 - r0) * s);

    // channel housing: dark trough + wall lines + end socket
    ctx.fillStyle = 'rgba(4,18,26,.85)';
    ctx.beginPath();
    if (dx) ctx.rect(Math.min(px(0), px(1)), c - w, Math.abs(px(1) - px(0)), w * 2);
    else ctx.rect(c - w, Math.min(py(0), py(1)), w * 2, Math.abs(py(1) - py(0)));
    ctx.fill();
    ctx.strokeStyle = 'rgba(90,130,150,.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px(0) + qx * w, py(0) + qy * w);
    ctx.lineTo(px(1) + qx * w, py(1) + qy * w);
    ctx.moveTo(px(0) - qx * w, py(0) - qy * w);
    ctx.lineTo(px(1) - qx * w, py(1) - qy * w);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px(1), py(1), w * 0.5, 0, TAU);
    ctx.fillStyle = '#31454f';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,220,240,.35)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    ctx.save();
    // clip plasma to the trough
    ctx.beginPath();
    if (dx) ctx.rect(Math.min(px(0), px(1)), c - w + 1, Math.abs(px(1) - px(0)), w * 2 - 2);
    else ctx.rect(c - w + 1, Math.min(py(0), py(1)), w * 2 - 2, Math.abs(py(1) - py(0)));
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';

    // faint drifting storm wisps
    for (let i = 0; i < 3; i++) {
      const s = Math.sin(t * (0.6 + i * 0.29) + di * 1.7 + i * 2.1) * 0.5 + 0.5;
      const bx = px(s) + qx * Math.sin(t * 2.1 + i) * (w * 0.3);
      const by = py(s) + qy * Math.sin(t * 2.1 + i) * (w * 0.3);
      const al = Math.max(0, (0.07 + 0.13 * surge) * (0.55 + 0.45 * Math.sin(t * 3 + i * 2 + di)) * glowF);
      g = ctx.createRadialGradient(bx, by, 0, bx, by, w + 2);
      g.addColorStop(0, `rgba(170,240,255,${al.toFixed(3)})`);
      g.addColorStop(1, 'rgba(60,190,235,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(bx, by, w + 2, 0, TAU);
      ctx.fill();
    }

    // the pulse packet — ejected from the core on each whump, rides the channel
    const bx = px(p);
    const by = py(p);
    const pa = Math.max(0, 0.95 - p * 0.45) * glowF;
    g = ctx.createRadialGradient(bx, by, 0, bx, by, w + 4);
    g.addColorStop(0, `rgba(255,255,255,${pa.toFixed(3)})`);
    g.addColorStop(0.35, `rgba(160,240,255,${(pa * 0.7).toFixed(3)})`);
    g.addColorStop(1, 'rgba(80,210,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(bx, by, w + 4, 0, TAU);
    ctx.fill();

    // trailing tail behind the packet
    g = dx
      ? ctx.createLinearGradient(px(Math.max(0, p - 0.5)), 0, bx, 0)
      : ctx.createLinearGradient(0, py(Math.max(0, p - 0.5)), 0, by);
    g.addColorStop(0, 'rgba(80,210,255,0)');
    g.addColorStop(1, `rgba(140,235,255,${(pa * 0.5).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.beginPath();
    if (dx) ctx.rect(Math.min(px(Math.max(0, p - 0.5)), bx), c - w * 0.25, Math.abs(bx - px(Math.max(0, p - 0.5))), w * 0.5);
    else ctx.rect(c - w * 0.25, Math.min(py(Math.max(0, p - 0.5)), by), w * 0.5, Math.abs(by - py(Math.max(0, p - 0.5))));
    ctx.fill();

    // micro lightning arcing down the channel
    if (Math.random() < 0.1 + surge * 0.28) {
      ctx.beginPath();
      ctx.moveTo(px(0), py(0));
      for (let s = 0.15; s <= 1; s += 0.14 + Math.random() * 0.1) {
        const o = (Math.random() - 0.5) * (w * 2 - 3);
        ctx.lineTo(px(s) + qx * o, py(s) + qy * o);
      }
      ctx.strokeStyle = `rgba(230,252,255,${(0.4 + 0.45 * surge * Math.random()).toFixed(3)})`;
      ctx.lineWidth = 1.6;
      ctx.shadowColor = 'rgba(120,235,255,1)';
      ctx.shadowBlur = 11 * glowF;
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${(0.5 + 0.35 * surge).toFixed(3)})`;
      ctx.lineWidth = 0.7;
      ctx.stroke(); // hot inner filament
      ctx.shadowBlur = 0;
    }
    ctx.restore();

    // socket flash when the packet arrives
    const arr = Math.exp(-Math.pow((p - 0.96) * 18, 2));
    if (arr > 0.02) {
      g = ctx.createRadialGradient(px(1), py(1), 0, px(1), py(1), 12);
      g.addColorStop(0, `rgba(200,250,255,${(arr * 0.8 * glowF).toFixed(3)})`);
      g.addColorStop(1, 'rgba(120,230,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px(1), py(1), 12, 0, TAU);
      ctx.fill();
    }
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/reactor/drawConduits.ts
git commit -m "feat: port the reactor conduit power-channel canvas draw"
```

---

### Task 15: Volumetric 2D housing overlay

Ported from the source's `drawCore()` (lines 1888–1985), specifically the branch reached when `vol` is true (VOLUMETRIC renderer, WebGL healthy): ambient glow spilling past the housing, probabilistic lightning filaments, the containment ring, 12-segment alloy plate ring, 12 glowing vent slits, 12 seam bolts, and the outer housing ring. This is drawn *on top of* the WebGL plasma storm (Task 13) each frame.

**Scope cut, documented:** the source also has a full CPU-only fallback path (interior plasma clouds, its own expanding surge wave, its own white-hot center) that activates when `this.glFail` is true — i.e., when `initGL` failed to compile/link the shader. That fallback is out of scope for this pass: modern browsers reliably support WebGL, so Task 17's dispatch treats a WebGL init failure the same as NEBULA (clear the canvas) rather than reimplementing the CPU plasma fallback. This is a deliberate scope cut, not an oversight — add it later if a real device without WebGL support needs to be handled.

**Files:**
- Create: `src/components/reactor/drawHousing.ts`

**Interfaces:**
- Consumes: a `CanvasRenderingContext2D` for the core canvas (from `ReactorFrame.coreCtx`, Task 12) — called *after* `drawCoreGL` (Task 13) has painted the same canvas's paired WebGL layer, so its output must sit visually on top.
- Produces: `drawHousing(ctx, params: DrawHousingParams): void` — called from Task 17's `ReactorCore` frame callback only when `cfg.renderer === 'volumetric'`.

No automated tests (imperative canvas drawing) — verified visually in Task 17.

- [ ] **Step 1: Implement src/components/reactor/drawHousing.ts**

```ts
export interface DrawHousingParams {
  t: number;
  surge: number;
  overdrive: boolean;
  glowFactor: number;
}

export function drawHousing(ctx: CanvasRenderingContext2D, params: DrawHousingParams): void {
  const { t, surge, overdrive: od, glowFactor: glowF } = params;
  const TAU = Math.PI * 2;
  const c = 112;
  const innerR = 74;

  // ambient glow spilling past the housing
  let g = ctx.createRadialGradient(c, c, 62, c, c, 112);
  g.addColorStop(0, `rgba(80,220,255,${Math.min(1, (0.1 + 0.28 * surge) * glowF).toFixed(3)})`);
  g.addColorStop(1, 'rgba(80,220,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 224, 224);

  // lightning filaments, clipped to the interior chamber
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, innerR, 0, TAU);
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';
  if (Math.random() < 0.45 + surge * 0.5 + (od ? 0.35 : 0)) {
    const bolts = od ? 3 : Math.random() < 0.25 + surge * 0.6 ? 2 : 1;
    for (let b = 0; b < bolts; b++) {
      let aa = Math.random() * TAU;
      let rr = 8;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(aa) * 6, c + Math.sin(aa) * 6);
      while (rr < innerR - 4) {
        rr += 8 + Math.random() * 8;
        aa += (Math.random() - 0.5) * 0.7;
        ctx.lineTo(c + Math.cos(aa) * rr, c + Math.sin(aa) * rr);
      }
      ctx.strokeStyle = `rgba(230,252,255,${(0.45 + 0.5 * surge * Math.random()).toFixed(3)})`;
      ctx.lineWidth = 1.9;
      ctx.shadowColor = 'rgba(120,235,255,1)';
      ctx.shadowBlur = 14;
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${(0.55 + 0.4 * surge).toFixed(3)})`;
      ctx.lineWidth = 0.8;
      ctx.stroke(); // hot inner filament
      ctx.shadowBlur = 0;
    }
  }
  ctx.restore();

  // ---- containment housing ----
  ctx.lineWidth = 3;
  ctx.strokeStyle = `rgba(140,240,255,${(0.45 + 0.55 * surge).toFixed(3)})`;
  ctx.shadowColor = 'rgba(120,235,255,0.8)';
  ctx.shadowBlur = (10 + 14 * surge) * glowF;
  ctx.beginPath();
  ctx.arc(c, c, innerR + 2, 0, TAU);
  ctx.stroke();
  ctx.shadowBlur = 0;

  const R0 = innerR + 5;
  const R1 = 106;
  const plate = ctx.createRadialGradient(c, c, R0, c, c, R1);
  plate.addColorStop(0, '#243743');
  plate.addColorStop(0.45, '#141f27');
  plate.addColorStop(1, '#0a1218');

  for (let i = 0; i < 12; i++) {
    // segmented alloy plates
    const a0 = (i * TAU) / 12 + 0.035;
    const a1 = ((i + 1) * TAU) / 12 - 0.035;
    ctx.beginPath();
    ctx.arc(c, c, R1, a0, a1);
    ctx.arc(c, c, R0, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = plate;
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,180,205,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  for (let i = 0; i < 12; i++) {
    // glowing vent slits, energy circulates
    const a = (i + 0.5) * (TAU / 12);
    const al = Math.max(0, 0.18 + 0.5 * surge + 0.28 * Math.max(0, Math.sin(a - t * 2)));
    ctx.strokeStyle = `rgba(120,235,255,${al.toFixed(3)})`;
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(120,235,255,0.8)';
    ctx.shadowBlur = (6 + 10 * surge) * glowF;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * (R0 + 7), c + Math.sin(a) * (R0 + 7));
    ctx.lineTo(c + Math.cos(a) * (R1 - 9), c + Math.sin(a) * (R1 - 9));
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  for (let i = 0; i < 12; i++) {
    // bolts at plate seams
    const a = (i * TAU) / 12;
    const x = c + Math.cos(a) * ((R0 + R1) / 2);
    const y = c + Math.sin(a) * ((R0 + R1) / 2);
    ctx.beginPath();
    ctx.arc(x, y, 2.6, 0, TAU);
    ctx.fillStyle = '#31454f';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,220,240,0.35)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(90,130,150,0.5)';
  ctx.beginPath();
  ctx.arc(c, c, R1 + 1, 0, TAU);
  ctx.stroke();
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/reactor/drawHousing.ts
git commit -m "feat: port the volumetric reactor's 2D alloy housing overlay"
```

---

### Task 16: Warp cross-section draw

Ported verbatim from the source's `drawWarp(ctx, t, surge, p, od, glowF)` (lines 1988–2168): a bilaterally-symmetric warp-core cross-section drawn entirely on the 2D core canvas (no WebGL) — flared antimatter-initiator caps with flickering ports, two amber capacitor-cell stages per side that light up as the pulse passes, counter-rotating membrane spinner ellipses, zero-point extraction bands, a central rounded vacuum-chamber lens with a churning cloud bed, twin pulses converging through the lens tips, a collision flash, occasional internal arcing, two breathing dashed containment-shield rings, focusing forcefield coils at the lens waist, and PTC docking cylinders reaching out to the horizontal conduits (drawn separately by Task 14 with `hubRadius: 48`).

No automated tests (imperative canvas drawing) — verified visually in Task 17.

**Files:**
- Create: `src/components/reactor/drawWarp.ts`

**Interfaces:**
- Consumes: a `CanvasRenderingContext2D` for the core canvas (from `ReactorFrame.coreCtx`, Task 12).
- Produces: `drawWarp(ctx, params: DrawWarpParams): void` — called from Task 17's `ReactorCore` frame callback only when `cfg.renderer === 'warp'`, alongside `drawConduits(conduitCtx, { ..., hubRadius: 48 })`.

- [ ] **Step 1: Implement src/components/reactor/drawWarp.ts**

```ts
export interface DrawWarpParams {
  t: number;
  surge: number;
  phase: number;
  overdrive: boolean;
  glowFactor: number;
}

export function drawWarp(ctx: CanvasRenderingContext2D, params: DrawWarpParams): void {
  const { t, surge, overdrive: od, glowFactor: glowF } = params;
  const p = params.phase;
  const TAU = Math.PI * 2;
  const c = 112;
  const th = 20;
  let g: CanvasGradient;

  // ambient column glow
  g = ctx.createRadialGradient(c, c, 10, c, c, 110);
  g.addColorStop(0, `rgba(80,220,255,${Math.min(1, (0.08 + 0.24 * surge) * glowF).toFixed(3)})`);
  g.addColorStop(1, 'rgba(80,220,255,0)');
  ctx.save();
  ctx.translate(c, c);
  ctx.scale(0.5, 1);
  ctx.translate(-c, -c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 224, 224);
  ctx.restore();

  const pd = (1 - p) * 96; // twin pulse offset from center
  const alloy = (y: number, h: number) => {
    const gg = ctx.createLinearGradient(0, y, 0, y + h);
    gg.addColorStop(0, '#2a3f4c');
    gg.addColorStop(0.5, '#141f27');
    gg.addColorStop(1, '#0a1218');
    return gg;
  };

  // outer casing silhouette
  ctx.fillStyle = '#0b161d';
  ctx.fillRect(c - th - 8, c - 102, (th + 8) * 2, 204);
  ctx.strokeStyle = 'rgba(120,180,205,.35)';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(c - th - 8, c - 102, (th + 8) * 2, 204);

  [-1, 1].forEach((sd) => {
    const Y = (off: number) => c + sd * off;

    // flared antimatter-initiator cap
    g = alloy(Math.min(Y(110), Y(96)), 14);
    ctx.beginPath();
    ctx.moveTo(c - th - 2, Y(96));
    ctx.lineTo(c + th + 2, Y(96));
    ctx.lineTo(c + th + 12, Y(110));
    ctx.lineTo(c - th - 12, Y(110));
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,180,205,.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // initiator port — flickers when a pulse is born (p near 0)
    const ia = Math.max(0, 0.25 + 0.75 * Math.exp(-p * 6)) * glowF;
    ctx.fillStyle = `rgba(190,245,255,${ia.toFixed(3)})`;
    ctx.shadowColor = 'rgba(120,235,255,.9)';
    ctx.shadowBlur = 8 * glowF;
    ctx.beginPath();
    ctx.arc(c, Y(103), 3, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;

    // two capacitor stages: rows of amber cells that light as the pulse passes
    ([
      [66, 92, 4],
      [45, 63, 3],
    ] as [number, number, number][]).forEach((st) => {
      const [o0, o1, rows] = st;
      const yTop = Math.min(Y(o0), Y(o1));
      const hh = Math.abs(Y(o1) - Y(o0));
      ctx.fillStyle = alloy(yTop, hh);
      ctx.fillRect(c - th - 4, yTop, (th + 4) * 2, hh);
      ctx.strokeStyle = 'rgba(120,180,205,.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(c - th - 4, yTop, (th + 4) * 2, hh);
      const rh = hh / rows;
      for (let rr = 0; rr < rows; rr++) {
        const cy = yTop + rh * (rr + 0.5);
        const near = Math.exp(-Math.pow((Math.abs(cy - c) - pd) / 9, 2));
        const cal = Math.min(1, 0.18 + 0.7 * near + 0.15 * surge) * glowF;
        [-1, 1].forEach((cs) => {
          const cx = c + cs * (th / 2 + 1);
          ctx.fillStyle = `rgba(245,198,107,${(cal * 0.85).toFixed(3)})`;
          ctx.shadowColor = 'rgba(245,198,107,.8)';
          ctx.shadowBlur = 6 * cal * glowF;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(cx - 6, cy - rh * 0.3, 12, rh * 0.6, 2);
          else ctx.rect(cx - 6, cy - rh * 0.3, 12, rh * 0.6);
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.strokeStyle = 'rgba(20,31,39,.9)';
          ctx.lineWidth = 1;
          ctx.stroke();
        });
      }
    });

    // membrane emitter/spinner — counter-rotating glow ellipse
    const sy = Y(38);
    ctx.fillStyle = alloy(sy - 5, 10);
    ctx.fillRect(c - th - 6, sy - 5, (th + 6) * 2, 10);
    ctx.strokeStyle = 'rgba(120,180,205,.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(c - th - 6, sy - 5, (th + 6) * 2, 10);
    const spin = t * 2.2 * sd;
    ctx.strokeStyle = `rgba(140,240,255,${((0.3 + 0.5 * surge) * glowF).toFixed(3)})`;
    ctx.lineWidth = 1.6;
    ctx.shadowColor = 'rgba(120,235,255,.8)';
    ctx.shadowBlur = 6 * glowF;
    ctx.beginPath();
    ctx.ellipse(c, sy, th + 2, 3.4, 0, spin, spin + TAU * 0.72);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // zero-point extraction band — thin bright ring where the lens meets the stack
    const zy = Y(31);
    const za = (0.35 + 0.65 * Math.exp(-Math.pow((31 - pd) / 8, 2))) * glowF;
    ctx.strokeStyle = `rgba(190,245,255,${za.toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(120,235,255,.9)';
    ctx.shadowBlur = 7 * glowF;
    ctx.beginPath();
    ctx.moveTo(c - th + 2, zy);
    ctx.lineTo(c + th - 2, zy);
    ctx.stroke();
    ctx.shadowBlur = 0;
  });

  // ---- central vacuum chamber: rounded sphere ----
  const lensH = 40;
  const lensW = 30;
  const lensPath = () => {
    ctx.beginPath();
    ctx.ellipse(c, c, lensW, lensH, 0, 0, TAU);
  };
  lensPath();
  g = ctx.createRadialGradient(c, c, 4, c, c, lensH);
  g.addColorStop(0, '#0c3d50');
  g.addColorStop(1, '#041722');
  ctx.fillStyle = g;
  ctx.fill();

  ctx.save();
  lensPath();
  ctx.clip();

  // membrane field — horizontal ribs
  ctx.strokeStyle = `rgba(130,220,250,${(0.22 * glowF).toFixed(3)})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let ry = -lensH + 4; ry <= lensH - 4; ry += 4) {
    ctx.moveTo(c - lensW * 2, c + ry);
    ctx.lineTo(c + lensW * 2, c + ry);
  }
  ctx.stroke();

  ctx.globalCompositeOperation = 'lighter';
  // churning cloud bed inside the chamber — blue wisps with white-hot knots
  for (let i = 0; i < 6; i++) {
    const a1 = t * (0.32 + i * 0.11) + i * 2.4;
    const a2 = t * (0.5 + i * 0.08) + i * 1.7;
    const cx2 = c + Math.cos(a1) * (lensW * 0.62) * Math.sin(a2 + i);
    const cy2 = c + Math.sin(a1 * 0.85 + 1.2) * (lensH * 0.62);
    const br = 10 + 9 * Math.abs(Math.sin(t * 0.7 + i * 2.1));
    const al = Math.max(0, (0.1 + 0.18 * surge) * (0.55 + 0.45 * Math.sin(t * 2.4 + i * 1.9))) * glowF;
    g = ctx.createRadialGradient(cx2, cy2, 0, cx2, cy2, br);
    g.addColorStop(0, i % 3 ? `rgba(150,225,255,${al.toFixed(3)})` : `rgba(255,255,255,${(al * 0.9).toFixed(3)})`);
    g.addColorStop(0.55, `rgba(70,180,240,${(al * 0.5).toFixed(3)})`);
    g.addColorStop(1, 'rgba(40,140,210,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx2, cy2, br, 0, TAU);
    ctx.fill();
  }

  // twin pulses converging through the lens tips
  [-1, 1].forEach((sd) => {
    const py2 = c + sd * pd;
    const pa = (0.5 + 0.4 * (1 - p)) * glowF;
    g = ctx.createRadialGradient(c, py2, 0, c, py2, 14);
    g.addColorStop(0, `rgba(255,255,255,${pa.toFixed(3)})`);
    g.addColorStop(0.4, `rgba(160,240,255,${(pa * 0.6).toFixed(3)})`);
    g.addColorStop(1, 'rgba(80,210,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c, py2, 14, 0, TAU);
    ctx.fill();
  });

  // vacuum chamber core — collision flash
  g = ctx.createRadialGradient(c, c, 0, c, c, 18 + 14 * surge);
  g.addColorStop(0, `rgba(255,255,255,${(0.28 + 0.7 * surge).toFixed(3)})`);
  g.addColorStop(0.45, `rgba(140,235,255,${(0.2 + 0.5 * surge).toFixed(3)})`);
  g.addColorStop(1, 'rgba(100,210,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, 18 + 14 * surge, 0, TAU);
  ctx.fill();

  // arcing inside the chamber
  if (Math.random() < 0.3 + surge * 0.5 + (od ? 0.25 : 0)) {
    const a0 = Math.random() * TAU;
    let xx = c + Math.cos(a0) * 4;
    let yy = c + Math.sin(a0) * 4;
    ctx.beginPath();
    ctx.moveTo(xx, yy);
    for (let sgm = 0; sgm < 4; sgm++) {
      xx += (Math.random() - 0.5) * 22;
      yy += (Math.random() - 0.5) * 26;
      ctx.lineTo(xx, yy);
    }
    ctx.strokeStyle = `rgba(230,252,255,${(0.5 + 0.45 * surge * Math.random()).toFixed(3)})`;
    ctx.lineWidth = 1.8;
    ctx.shadowColor = 'rgba(120,235,255,1)';
    ctx.shadowBlur = 13 * glowF;
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${(0.6 + 0.35 * surge).toFixed(3)})`;
    ctx.lineWidth = 0.7;
    ctx.stroke(); // hot inner filament
    ctx.shadowBlur = 0;
  }
  ctx.restore();

  // chamber rim + pulsing containment shield rings
  lensPath();
  ctx.strokeStyle = `rgba(150,235,255,${((0.4 + 0.5 * surge) * glowF).toFixed(3)})`;
  ctx.lineWidth = 1.6;
  ctx.shadowColor = 'rgba(120,235,255,.8)';
  ctx.shadowBlur = (5 + 9 * surge) * glowF;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // shield: two breathing rings just outside the chamber, expanding softly on each whump
  for (let sh = 0; sh < 2; sh++) {
    const grow = 3 + sh * 4 + surge * 5 + Math.sin(t * 1.6 + sh * 1.4) * 1.5;
    const sa = Math.max(0, 0.28 - sh * 0.1 + 0.35 * surge) * glowF;
    ctx.strokeStyle = `rgba(120,225,255,${sa.toFixed(3)})`;
    ctx.lineWidth = 1.1 - sh * 0.3;
    ctx.setLineDash([7, 5]);
    ctx.lineDashOffset = -t * 14 * (sh ? -1 : 1);
    ctx.beginPath();
    ctx.ellipse(c, c, lensW + grow, lensH + grow, 0, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // focusing forcefield coils at the lens waist
  [-1, 1].forEach((cs) => {
    const cx = c + cs * (lensW + 7);
    ctx.fillStyle = alloy(c - 7, 14);
    ctx.beginPath();
    ctx.ellipse(cx, c, 5, 7, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,180,205,.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = `rgba(140,235,255,${((0.3 + 0.6 * surge) * glowF).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(cx, c, 2, 0, TAU);
    ctx.fill();
  });

  // PTC docking cylinders reaching toward the horizontal conduits
  [-1, 1].forEach((cs) => {
    const x0 = c + cs * (lensW + 10);
    const x1 = c + cs * 52;
    const hw2 = 9;
    g = ctx.createLinearGradient(0, c - hw2, 0, c + hw2);
    g.addColorStop(0, '#2a3f4c');
    g.addColorStop(0.5, '#18242d');
    g.addColorStop(1, '#0a1218');
    ctx.fillStyle = g;
    ctx.fillRect(Math.min(x0, x1), c - hw2, Math.abs(x1 - x0), hw2 * 2);
    ctx.strokeStyle = 'rgba(120,180,205,.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.min(x0, x1), c - hw2, Math.abs(x1 - x0), hw2 * 2);
    // energy window along the cylinder — carries the outbound pulse glow
    const wa = (0.18 + 0.5 * surge) * glowF;
    ctx.fillStyle = `rgba(120,225,255,${wa.toFixed(3)})`;
    ctx.shadowColor = 'rgba(120,235,255,.8)';
    ctx.shadowBlur = 6 * surge * glowF;
    ctx.fillRect(Math.min(x0, x1) + 2, c - 2, Math.abs(x1 - x0) - 4, 4);
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.ellipse(x1, c, 3.5, hw2 + 1, 0, 0, TAU);
    ctx.fillStyle = '#31454f';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,220,240,.35)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0. (`CanvasRenderingContext2D.roundRect` is part of the TS 5.6 DOM lib, so the runtime feature-detect `if (ctx.roundRect)` — kept from the source for older-browser safety — typechecks without a cast.)

- [ ] **Step 3: Commit**

```bash
git add src/components/reactor/drawWarp.ts
git commit -m "feat: port the warp-core cross-section canvas draw"
```

---

### Task 17: Final integration — mount the reactor, wire renderer/theme commands, QA

Composes Tasks 12–16 into the real `ReactorCore` frame dispatch, replicating the source's `drawCore()` branching (lines 1863–1985) exactly: NEBULA draws only the GL storm (soft falloff, no housing, conduits cleared); VOLUMETRIC draws the GL storm (hard clip) with the 2D housing overlay and conduits on top; WARP skips GL entirely and draws the 2D cross-section plus hub-docked conduits. A WebGL init failure on NEBULA/VOLUMETRIC falls back to the VOLUMETRIC housing+conduits path forever after (the `glFailedRef` latch), per Task 15's documented scope cut. Mounts `ReactorCore` into `TerminalView` in place of Task 10's placeholder circle.

**Files:**
- Modify: `src/components/reactor/ReactorCore.tsx` (replacing Task 12's clear-only draw callback)
- Modify: `src/components/terminal/TerminalView.tsx` (swap the placeholder `<div style={coreCircleStyle} />` for `<ReactorCore />`)

**Interfaces:**
- Consumes: everything produced by Tasks 12–16 — `useReactorCanvas`/`ReactorFrame`, `initGL`/`drawCoreGL`/`GLProgram`, `drawHousing`, `drawConduits`, `drawWarp`; `useAetherStore()` for `state.cfg.renderer`/`state.rate`.

- [ ] **Step 1: Replace src/components/reactor/ReactorCore.tsx's draw callback**

```tsx
import { useRef, type CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { useReactorCanvas, type ReactorFrame } from './useReactorCanvas';
import { initGL, drawCoreGL, type GLProgram } from './glShader';
import { drawHousing } from './drawHousing';
import { drawConduits } from './drawConduits';
import { drawWarp } from './drawWarp';

export function ReactorCore() {
  const { state } = useAetherStore();
  const glProgramRef = useRef<GLProgram | null>(null);
  const glInitedRef = useRef(false);
  const glFailedRef = useRef(false);

  const { coreRef, glRef, conduitRef } = useReactorCanvas((frame: ReactorFrame) => {
    const renderer = state.cfg.renderer;
    const warp = renderer === 'warp';
    const neb = renderer === 'classic' && !glFailedRef.current;
    const vol = renderer === 'volumetric' && !glFailedRef.current;

    if (vol || neb) {
      if (!glInitedRef.current) {
        glProgramRef.current = initGL(frame.glCanvas);
        glInitedRef.current = true;
        if (!glProgramRef.current) glFailedRef.current = true;
      }
      if (glProgramRef.current) {
        drawCoreGL(glProgramRef.current, {
          t: frame.t,
          surge: frame.surge,
          phase: frame.phase,
          overdrive: frame.overdrive,
          glowFactor: frame.glowFactor,
          burnRate: state.rate,
          soft: neb,
        });
      }
    }
    frame.glCanvas.style.display = vol || neb ? 'block' : 'none';

    if (neb && glProgramRef.current) {
      // frameless nebula: no housing, no conduits — just the storm, fading at its own edge
      frame.coreCtx.setTransform(1, 0, 0, 1, 0, 0);
      frame.coreCtx.clearRect(0, 0, 448, 448);
      frame.conduitCtx.setTransform(1, 0, 0, 1, 0, 0);
      frame.conduitCtx.clearRect(0, 0, 668, 668);
      return;
    }

    if (warp) {
      frame.coreCtx.setTransform(1, 0, 0, 1, 0, 0);
      frame.coreCtx.clearRect(0, 0, 448, 448);
      frame.coreCtx.setTransform(2, 0, 0, 2, 0, 0);
      drawConduits(frame.conduitCtx, { t: frame.t, surge: frame.surge, phase: frame.phase, glowFactor: frame.glowFactor, hubRadius: 48 });
      drawWarp(frame.coreCtx, { t: frame.t, surge: frame.surge, phase: frame.phase, overdrive: frame.overdrive, glowFactor: frame.glowFactor });
      return;
    }

    // VOLUMETRIC (GL healthy) or a WebGL init failure on NEBULA/VOLUMETRIC — housing overlay + conduits
    frame.coreCtx.setTransform(1, 0, 0, 1, 0, 0);
    frame.coreCtx.clearRect(0, 0, 448, 448);
    frame.coreCtx.setTransform(2, 0, 0, 2, 0, 0);
    drawHousing(frame.coreCtx, { t: frame.t, surge: frame.surge, overdrive: frame.overdrive, glowFactor: frame.glowFactor });
    drawConduits(frame.conduitCtx, { t: frame.t, surge: frame.surge, phase: frame.phase, glowFactor: frame.glowFactor, channelWidth: 14 });
  });

  return (
    <>
      <canvas ref={conduitRef} width={668} height={668} style={conduitCanvasStyle} />
      <canvas ref={glRef} width={448} height={448} style={glCanvasStyle} />
      <canvas ref={coreRef} width={448} height={448} style={coreCanvasStyle} />
    </>
  );
}

const conduitCanvasStyle: CSSProperties = { position: 'absolute', inset: 0, width: 334, height: 334 };
const glCanvasStyle: CSSProperties = { position: 'absolute', width: 224, height: 224 };
const coreCanvasStyle: CSSProperties = { position: 'relative', width: 224, height: 224, display: 'block' };
```

- [ ] **Step 2: Mount ReactorCore in TerminalView**

In `src/components/terminal/TerminalView.tsx`: add `import { ReactorCore } from '../reactor/ReactorCore';` and replace

```tsx
<div style={coreFloatWrapStyle}>
  {/* Task 17 replaces this placeholder with <ReactorCore /> */}
  <div style={coreCircleStyle} />
</div>
```

with

```tsx
<div style={coreFloatWrapStyle}>
  <ReactorCore />
</div>
```

Remove the now-unused `coreCircleStyle` constant.

- [ ] **Step 3: Run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all Vitest suites PASS (tokens, format, reducer, tick, persistence, commands, reactorMath — the full count from Tasks 1–16), 0 type errors, build succeeds.

- [ ] **Step 4: Manual QA checklist — run through every renderer, theme, and alarm state**

Run: `npm run dev`, open the Terminal view.

- [ ] The reactor loads in NEBULA mode by default (`cfg.renderer: 'classic'` from `initialState`) — a soft-edged cyan plasma cloud breathing in place, no visible housing ring, no conduits.
- [ ] Type `renderer volumetric` — the cloud gains a hard circular edge, a 12-plate alloy housing ring appears around it with glowing vent slits and seam bolts, and 4 power conduits extend from the housing to the canvas edge with a bright pulse packet visibly traveling outward on each "whump."
- [ ] Type `renderer warp` — the plasma disappears entirely, replaced by the bilateral cross-section: amber capacitor cells lighting up top and bottom as the pulse passes, a central lens with churning cloud bed, breathing dashed shield rings, and conduits now docking into the narrow hub instead of the wide housing ring.
- [ ] Type `renderer nebula` — back to the frameless cloud.
- [ ] Type `theme blue`, `theme teal`, `theme violet`, `theme amber`, `theme red` in sequence, checking the whole reactor (all three canvases, since the CSS `filter: hue-rotate()` is applied uniformly) shifts color each time, then `theme cyan` to reset.
- [ ] Spawn agents (`spawn`, repeat until 7+ active) to trigger "overdrive" — lightning frequency and cloud growth should visibly increase in VOLUMETRIC/NEBULA; more frequent arcing in WARP.
- [ ] Approve the seeded HIGH-risk approval (`approve 1`) a few times as new ones appear (or just wait — the tick occasionally files new ones) to push the burn rate toward the alarm threshold; confirm the footer flips "ALL GOOD" → "BURN ELEVATED" (amber) → "BURN ALARM" (red), the reactor's hue overrides to amber/red regardless of the chosen theme, and the pulse visibly speeds up (shorter `--pulse-dur`).
- [ ] Reload the page — `cfg.renderer`/`cfg.theme`/`agents`/etc. persist from `localStorage` (Task 6); confirm the reactor resumes in the last-selected renderer/theme.

- [ ] **Step 5: Self-review against the spec**

Skim `README.md`'s Terminal/Reactor-core/Top-bar/Sidebar/Footer sections one more time against what was built. Confirm every documented terminal command, every reactor renderer, and every piece of shared chrome has a corresponding task above. Confirm no step in this plan contains "TODO"/"handle appropriately"/unimplemented placeholder code — every code block is complete and runnable as written, with cut scope documented explicitly (Global Constraints section, plus the two scope-cut notes in Tasks 15 and 9's typo fix).

- [ ] **Step 6: Commit**

```bash
git add src/components/reactor/ReactorCore.tsx src/components/terminal/TerminalView.tsx
git commit -m "feat: compose the full reactor core (NEBULA/VOLUMETRIC/WARP) and mount it in the Terminal view"
```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-16-aether-os-scaffold-terminal.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, with review between tasks and fast iteration. Best given how independently testable most tasks are (each has its own Vitest suite or a scoped manual QA step).

**2. Inline Execution** — execute tasks in this session using `executing-plans`, batch execution with checkpoints for review.

**Which approach?**
