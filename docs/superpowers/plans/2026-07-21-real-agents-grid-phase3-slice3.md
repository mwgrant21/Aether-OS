# Real Active Agents in the Orchestration Grid (Phase 3, slice 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Orchestration Grid's agent ring with real Claude Code `Agent`-dispatch data, and remove the project ring/assignment-link machinery entirely (no real "project" concept exists yet).

**Architecture:** Add real-data layout functions to `gridMath.ts` alongside the existing fictional-agent ones (additive at first), rewrite `OrchestrationGrid.tsx` to render only the hub + a real-dispatch ring + feed links (no project ring), rewire `GridView.tsx` and fix its previously-broken click-to-select navigation, then remove the now-dead fictional-agent grid functions once genuinely safe.

**Tech Stack:** TypeScript, React 18, Vitest, SVG.

## Global Constraints

- The project ring, crew-clustering, and assignment-link logic are removed entirely, not migrated — `state.projects`, `ProjectStub.crew`, and `onOpenProjects` all disappear from this view. Projects has no real-data phase yet; `ProjectsView.tsx` is untouched.
- Feed-link stroke width is driven by elapsed time, not a real per-dispatch share metric. The scale is a 10-minute window (`10 * 60 * 1000` ms), matching `realUsageMath.ts`'s existing `BURN_WINDOW_MIN = 10` constant in spirit (that constant is a private, non-exported module-level `const` in a different file — this plan defines its own local constant with the same value and an explanatory comment, not a cross-file import of a non-exported symbol).
- The hub's own rate readout (`formatHubRate(rate)`, using `state.rate`) is left completely untouched — out of scope, a Phase 2/simulated-reactor concern, not part of "real Agents."
- Clicking an agent node must dispatch `SELECT_REAL_AGENT` (not the old `SELECT_AGENT`) with the dispatch's `toolUseId`, fixing a click-through that has been silently broken since the Agents view (a separate, already-shipped slice) started reading only real data.
- Node avatars use a fixed accent color and a 2-letter code derived from `subagentType`, matching every other real-data card in this app — no per-node hue (real dispatches have no color identity).
- Dead code (`computeAgentNodes`, `computeProjectNodes`, `computeFeedLinks`, `computeAssignmentLinks`, `computeFeedStrokeWidth`, `circularMeanAngle`, `clampBoxCenter`, the `AgentNode`/`ProjectNode`/`FeedLink`/`AssignmentLink`/`GridLayout` types, and the now-unused `PROJECT_RING_RADIUS`/`PROJECT_BOX_W`/`PROJECT_BOX_H` constants) is removed only once `OrchestrationGrid.tsx`/`GridView.tsx` have already stopped using it and the build is confirmed clean — never removed first.
- Baseline before this plan: 297 passing tests across 28 files, clean `tsc -b` (plain, not `--noEmit` — this project's composite tsconfig setup errors on that flag combination), clean `electron:build`, working tree clean (aside from pre-existing unrelated untracked screenshot `.jpg` files) at commit `1f26119` (the spec commit).

---

## File Structure

| File | Change |
|---|---|
| `src/components/grid/gridMath.ts` | Add `RealAgentNode`/`RealFeedLink`/`RealGridLayout` types and `computeRealAgentNodes`/`computeFeedStrokeWidthByElapsed`/`computeRealFeedLinks`/`computeRealGridLayout` (Task 1, additive). Remove the fictional-agent functions/types and the now-unused project-box constants (Task 3, once safe). |
| `src/components/grid/gridMath.test.ts` | Add tests for the four new functions (Task 1). Remove the fictional-agent describe blocks and their `mockAgent`/`mockProject` helpers (Task 3). |
| `src/components/grid/OrchestrationGrid.tsx` | Rewrite: real-dispatch props, live elapsed-time ticking, no project ring/assignment links, empty state, fixed accent-color nodes (Task 2). |
| `src/components/grid/GridView.tsx` | Rewire to pass `state.realAgents`, drop `projects`/`onOpenProjects`, dispatch `SELECT_REAL_AGENT` (Task 3). |

---

### Task 1: Real-data layout functions in `gridMath.ts`

**Files:**
- Modify: `src/components/grid/gridMath.ts`
- Modify: `src/components/grid/gridMath.test.ts`

**Interfaces:**
- Consumes: `RealAgentDispatch` from `src/state/liveAgentsMath.ts` (existing, shipped in an earlier Phase 3 slice); `HUB_X`, `HUB_Y`, `AGENT_RING_RADIUS`, `agentAngle` (existing, unchanged, reused as-is).
- Produces: `RealAgentNode { agent: RealAgentDispatch; angle: number; x: number; y: number }`; `RealFeedLink { toolUseId: string; x1: number; y1: number; x2: number; y2: number; strokeWidth: number }`; `RealGridLayout { hub: { x: number; y: number }; agentNodes: RealAgentNode[]; feedLinks: RealFeedLink[]; agentCount: number; linkCount: number }`; `computeRealAgentNodes(agents: RealAgentDispatch[]): RealAgentNode[]`; `computeFeedStrokeWidthByElapsed(elapsedMs: number): number`; `computeRealFeedLinks(agentNodes: RealAgentNode[], now: number): RealFeedLink[]`; `computeRealGridLayout(agents: RealAgentDispatch[], now: number): RealGridLayout`. Task 2's `OrchestrationGrid.tsx` calls `computeRealGridLayout` and uses `RealAgentNode`/`ViewportTransform` (existing) for rendering.

This task is purely additive — none of the existing fictional-agent functions/types/constants in `gridMath.ts` are touched or removed here (that happens in Task 3, once genuinely safe).

- [ ] **Step 1: Write the failing tests**

Add this import and these `describe` blocks to `src/components/grid/gridMath.test.ts` (add the import alongside the existing ones at the top; append the blocks after the existing `formatHubRate` describe block, which is the last one in the file):

```typescript
import type { RealAgentDispatch } from '../../state/liveAgentsMath';
```

```typescript
function mockRealAgent(toolUseId: string, startedAt: string, subagentType = 'general-purpose'): RealAgentDispatch {
  return { toolUseId, subagentType, description: 'Working', startedAt, prompt: 'do work', model: null };
}

describe('computeRealAgentNodes', () => {
  it('places 4 real dispatches evenly on the 165-radius ring around the (500, 315) hub', () => {
    const nodes = computeRealAgentNodes([
      mockRealAgent('tu_0', '2026-07-21T10:00:00.000Z'),
      mockRealAgent('tu_1', '2026-07-21T10:00:00.000Z'),
      mockRealAgent('tu_2', '2026-07-21T10:00:00.000Z'),
      mockRealAgent('tu_3', '2026-07-21T10:00:00.000Z'),
    ]);
    expect(nodes).toHaveLength(4);
    expect(nodes[0].x).toBeCloseTo(500);
    expect(nodes[0].y).toBeCloseTo(150);
    expect(nodes[1].x).toBeCloseTo(665);
    expect(nodes[1].y).toBeCloseTo(315);
    expect(nodes[2].x).toBeCloseTo(500);
    expect(nodes[2].y).toBeCloseTo(480);
    expect(nodes[3].x).toBeCloseTo(335);
    expect(nodes[3].y).toBeCloseTo(315);
  });

  it('returns an empty array with zero real dispatches instead of dividing by zero', () => {
    expect(computeRealAgentNodes([])).toEqual([]);
  });
});

describe('computeFeedStrokeWidthByElapsed', () => {
  it('scales linearly between a 1.5 floor and an 8.5 ceiling across the 10-minute window', () => {
    expect(computeFeedStrokeWidthByElapsed(0)).toBeCloseTo(1.5);
    expect(computeFeedStrokeWidthByElapsed(10 * 60 * 1000)).toBeCloseTo(8.5);
    expect(computeFeedStrokeWidthByElapsed(5 * 60 * 1000)).toBeCloseTo(5.0);
  });

  it('clamps beyond the 10-minute window instead of exceeding the ceiling', () => {
    expect(computeFeedStrokeWidthByElapsed(60 * 60 * 1000)).toBeCloseTo(8.5);
  });

  it('clamps negative elapsed time instead of producing a degenerate stroke', () => {
    expect(computeFeedStrokeWidthByElapsed(-500)).toBeCloseTo(1.5);
  });
});

describe('computeRealFeedLinks', () => {
  it('draws one feed link per real dispatch from the hub, widened by elapsed time', () => {
    const now = new Date('2026-07-21T10:05:00.000Z').getTime();
    const agentNodes = computeRealAgentNodes([mockRealAgent('tu_0', '2026-07-21T10:00:00.000Z')]);
    const [link] = computeRealFeedLinks(agentNodes, now);
    expect(link.toolUseId).toBe('tu_0');
    expect(link.x1).toBe(500);
    expect(link.y1).toBe(315);
    expect(link.x2).toBeCloseTo(agentNodes[0].x);
    expect(link.y2).toBeCloseTo(agentNodes[0].y);
    expect(link.strokeWidth).toBeCloseTo(5.0);
  });
});

describe('computeRealGridLayout', () => {
  it('composes real agent nodes and feed links, deriving header stats from them, with no project fields', () => {
    const now = new Date('2026-07-21T10:05:00.000Z').getTime();
    const layout = computeRealGridLayout(
      [mockRealAgent('tu_0', '2026-07-21T10:00:00.000Z'), mockRealAgent('tu_1', '2026-07-21T10:00:00.000Z')],
      now,
    );
    expect(layout.agentCount).toBe(2);
    expect(layout.linkCount).toBe(layout.feedLinks.length);
    expect(layout.linkCount).toBe(2);
    expect('projectNodes' in layout).toBe(false);
    expect('assignmentLinks' in layout).toBe(false);
  });

  it('renders just the hub, with no nodes or links, for zero open dispatches', () => {
    const layout = computeRealGridLayout([], Date.now());
    expect(layout.hub).toEqual({ x: 500, y: 315 });
    expect(layout.agentNodes).toEqual([]);
    expect(layout.feedLinks).toEqual([]);
    expect(layout.agentCount).toBe(0);
    expect(layout.linkCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/components/grid/gridMath.test.ts`
Expected: FAIL — `computeRealAgentNodes`/`computeFeedStrokeWidthByElapsed`/`computeRealFeedLinks`/`computeRealGridLayout` are not exported yet.

- [ ] **Step 3: Implement the new functions**

Add this import to the top of `src/components/grid/gridMath.ts`, alongside the existing `import type { Agent, ProjectStub } from '../../state/types';` (do not remove that existing import yet — it's still needed by the fictional-agent functions until Task 3):

```typescript
import type { RealAgentDispatch } from '../../state/liveAgentsMath';
```

Add these types and functions to `src/components/grid/gridMath.ts` (anywhere after the existing type/constant declarations — e.g. alongside the existing `AgentNode`/`FeedLink`/`GridLayout` types and `computeAgentNodes`/`computeFeedLinks`/`computeGridLayout` functions):

```typescript
export interface RealAgentNode {
  agent: RealAgentDispatch;
  angle: number;
  x: number;
  y: number;
}

export interface RealFeedLink {
  toolUseId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeWidth: number;
}

export interface RealGridLayout {
  hub: { x: number; y: number };
  agentNodes: RealAgentNode[];
  feedLinks: RealFeedLink[];
  agentCount: number;
  linkCount: number;
}

export function computeRealAgentNodes(agents: RealAgentDispatch[]): RealAgentNode[] {
  const total = agents.length;
  return agents.map((agent, index) => {
    const angle = agentAngle(index, total);
    const x = HUB_X + AGENT_RING_RADIUS * Math.cos(angle);
    const y = HUB_Y + AGENT_RING_RADIUS * Math.sin(angle);
    return { agent, angle, x, y };
  });
}

// Matches realUsageMath.ts's BURN_WINDOW_MIN (10 minutes) in spirit -- a
// dispatch's feed link thickens toward the same max width
// computeFeedStrokeWidth(share) already produces, reaching it once the
// dispatch has been running about as long as that already-established
// "significant" window, rather than an arbitrary new cutoff. Not an actual
// import, since BURN_WINDOW_MIN is a private const in a different file.
const ELAPSED_STROKE_WINDOW_MS = 10 * 60 * 1000;

export function computeFeedStrokeWidthByElapsed(elapsedMs: number): number {
  const clamped = Math.max(0, Math.min(1, elapsedMs / ELAPSED_STROKE_WINDOW_MS));
  return 1.5 + clamped * 7;
}

export function computeRealFeedLinks(agentNodes: RealAgentNode[], now: number): RealFeedLink[] {
  return agentNodes.map((n) => ({
    toolUseId: n.agent.toolUseId,
    x1: HUB_X,
    y1: HUB_Y,
    x2: n.x,
    y2: n.y,
    strokeWidth: computeFeedStrokeWidthByElapsed(now - new Date(n.agent.startedAt).getTime()),
  }));
}

export function computeRealGridLayout(agents: RealAgentDispatch[], now: number): RealGridLayout {
  const agentNodes = computeRealAgentNodes(agents);
  const feedLinks = computeRealFeedLinks(agentNodes, now);
  return {
    hub: { x: HUB_X, y: HUB_Y },
    agentNodes,
    feedLinks,
    agentCount: agents.length,
    linkCount: feedLinks.length,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/components/grid/gridMath.test.ts`
Expected: PASS — all tests in the file green, including the 8 new tests plus the 26 existing ones (still present, still passing — not removed in this task).

- [ ] **Step 5: Run the full suite and type checker**

Run: `npm test && npx tsc -b`
Expected: 305 tests pass (297 baseline + 8 new); `tsc -b` clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/grid/gridMath.ts src/components/grid/gridMath.test.ts
git commit -m "feat: add real-dispatch layout functions to gridMath"
```

---

### Task 2: Rewrite `OrchestrationGrid.tsx`

**Files:**
- Modify: `src/components/grid/OrchestrationGrid.tsx`

**Interfaces:**
- Consumes: `RealAgentDispatch` from `src/state/liveAgentsMath.ts` (existing); `computeRealGridLayout`, `RealAgentNode`, `AGENT_NODE_RADIUS`, `computeViewportTransform`, `formatHubRate`, `toScreenPoint`, `ViewportTransform` from `./gridMath` (Task 1 + existing).
- Produces: `OrchestrationGrid` now takes `{ agents: RealAgentDispatch[]; rate: number; onSelectRealAgent: (toolUseId: string) => void }` (changed from `{ agents: Agent[]; projects: ProjectStub[]; rate: number; onSelectAgent: (name: string) => void; onOpenProjects: () => void }`). Task 3's `GridView.tsx` passes these new props.

This task has no new pure logic — a component rewrite, verified by manual GUI verification in Task 3.

- [ ] **Step 1: Read the current file**

Read `src/components/grid/OrchestrationGrid.tsx` in full before editing (required by this project's CLAUDE.md: read before editing).

- [ ] **Step 2: Rewrite the component**

Replace the full contents of `src/components/grid/OrchestrationGrid.tsx` with:

```tsx
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import type { RealAgentDispatch } from '../../state/liveAgentsMath';
import {
  AGENT_NODE_RADIUS,
  computeRealGridLayout,
  computeViewportTransform,
  formatHubRate,
  toScreenPoint,
  type RealAgentNode,
  type ViewportTransform,
} from './gridMath';

interface OrchestrationGridProps {
  agents: RealAgentDispatch[];
  rate: number;
  onSelectRealAgent: (toolUseId: string) => void;
}

export function OrchestrationGrid({ agents, rate, onSelectRealAgent }: OrchestrationGridProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const layout = useMemo(() => computeRealGridLayout(agents, now), [agents, now]);

  // The SVG scales via preserveAspectRatio="xMidYMid meet", which letterboxes
  // whenever this panel's aspect ratio doesn't exactly match the 1000x630
  // viewBox (true for almost any real window size). The HTML label overlay
  // below can't inherit that transform, so its screen position is derived
  // from the panel's actual measured size instead of a naive percentage --
  // see gridMath.ts#computeViewportTransform for why.
  const sceneRef = useRef<HTMLDivElement>(null);
  const [sceneSize, setSceneSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = sceneRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSceneSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const viewport: ViewportTransform = useMemo(
    () => computeViewportTransform(sceneSize.width, sceneSize.height),
    [sceneSize.width, sceneSize.height],
  );

  return (
    <div style={rootStyle}>
      <div style={headerStyle}>
        <div style={titleStyle}>ORCHESTRATION GRID</div>
        <div style={statsStyle}>
          {layout.agentCount} AGENTS · {layout.linkCount} LINKS
        </div>
      </div>

      <div style={sceneStyle} ref={sceneRef}>
        <svg viewBox="0 0 1000 630" preserveAspectRatio="xMidYMid meet" style={svgStyle}>
          <defs>
            <radialGradient id="gridHubCore" cx="44%" cy="38%" r="65%">
              <stop offset="0%" stopColor="#fff" />
              <stop offset="30%" stopColor={colors.accentCyan} />
              <stop offset="64%" stopColor={colors.accentCyanDeep} />
              <stop offset="100%" stopColor="#0a5f74" />
            </radialGradient>
            <radialGradient id="gridHubGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(95,240,255,.35)" />
              <stop offset="100%" stopColor="rgba(95,240,255,0)" />
            </radialGradient>
          </defs>

          {layout.feedLinks.map((link) => (
            <line
              key={link.toolUseId}
              x1={link.x1}
              y1={link.y1}
              x2={link.x2}
              y2={link.y2}
              stroke={colors.accentCyanSoft}
              strokeWidth={link.strokeWidth}
              strokeDasharray="5 9"
              strokeOpacity={0.85}
              style={{ animation: 'dashFlow 1.4s linear infinite' }}
            />
          ))}

          <circle cx={layout.hub.x} cy={layout.hub.y} r={95} fill="url(#gridHubGlow)" />
          <circle cx={layout.hub.x} cy={layout.hub.y} r={70} fill="none" stroke="rgba(95,240,255,.35)" strokeWidth={1.5} strokeDasharray="4 6" />
          <circle
            cx={layout.hub.x}
            cy={layout.hub.y}
            r={46}
            fill="url(#gridHubCore)"
            style={{ filter: 'drop-shadow(0 0 16px rgba(95,240,255,.85))' }}
          />

          {layout.agentNodes.map((node) => (
            <g key={node.agent.toolUseId} onClick={() => onSelectRealAgent(node.agent.toolUseId)} style={{ cursor: 'pointer' }}>
              <circle cx={node.x} cy={node.y} r={AGENT_NODE_RADIUS} fill="rgba(6,20,28,.65)" stroke={colors.accentCyanSoft} strokeWidth={2} />
              <circle cx={node.x} cy={node.y} r={6} fill={colors.accentCyanSoft} style={{ filter: `drop-shadow(0 0 6px ${colors.accentCyanSoft})` }} />
              <text
                x={node.x}
                y={node.y}
                textAnchor="middle"
                dominantBaseline="central"
                style={{ font: `700 13px ${fonts.mono}`, fill: colors.accentCyanSoft }}
              >
                {node.agent.subagentType.slice(0, 2).toUpperCase()}
              </text>
            </g>
          ))}
        </svg>

        <div style={overlayStyle}>
          {viewport.scale > 0 && (
            <>
              <div style={hubLabelWrapStyle(layout.hub.x, layout.hub.y, viewport)}>
                <div style={hubNameStyle}>AETHER CORE</div>
                <div style={hubRateStyle}>{formatHubRate(rate)}</div>
              </div>

              {layout.agentNodes.map((node: RealAgentNode) => (
                <div key={node.agent.toolUseId} style={agentLabelWrapStyle(node, viewport)}>
                  <div style={agentNameStyle}>{node.agent.subagentType}</div>
                  <div style={agentRoleStyle}>{node.agent.description}</div>
                </div>
              ))}
            </>
          )}
          {!layout.agentNodes.length && <div style={emptyStyle}>no agents currently running</div>}
        </div>
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  padding: 16,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
};
const headerStyle: CSSProperties = { flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' };
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const statsStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim };
const sceneStyle: CSSProperties = { position: 'relative', flex: 1, minHeight: 0, marginTop: 10 };
const svgStyle: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' };
const overlayStyle: CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none' };
const emptyStyle: CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, 90px)',
  font: `400 12px/1.4 ${fonts.ui}`,
  color: colors.textDim,
  textAlign: 'center',
};

function hubLabelWrapStyle(x: number, y: number, viewport: ViewportTransform): CSSProperties {
  const { screenX, screenY } = toScreenPoint(x, y, viewport);
  return {
    position: 'absolute',
    left: `${screenX}px`,
    top: `${screenY}px`,
    transform: 'translate(-50%, 34px)',
    textAlign: 'center',
  };
}
const hubNameStyle: CSSProperties = { font: `700 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textPrimary };
const hubRateStyle: CSSProperties = { marginTop: 4, font: `400 10px/1 ${fonts.mono}`, color: colors.accentCyanSoft };

function agentLabelWrapStyle(node: RealAgentNode, viewport: ViewportTransform): CSSProperties {
  const { screenX, screenY } = toScreenPoint(node.x, node.y, viewport);
  return {
    position: 'absolute',
    left: `${screenX}px`,
    top: `${screenY}px`,
    transform: 'translate(-50%, 38px)',
    width: 130,
    textAlign: 'center',
  };
}
const agentNameStyle: CSSProperties = {
  font: `600 12px/1 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const agentRoleStyle: CSSProperties = {
  marginTop: 2,
  font: `400 10px/1.3 ${fonts.ui}`,
  color: colors.textMuted,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
```

This drops the project-ring `<rect>` block, the assignment-link `<line>` block, and the `projectLabelWrapStyle`/`projectNameStyle`/`projectMetaStyle` style helpers entirely (no real project concept exists). Feed links and node circles/text use a fixed `colors.accentCyanSoft` instead of `link.hue`/`node.agent.hue` (real dispatches have no per-item color identity, matching every other real-data view). Node avatar text derives from `subagentType` instead of `agent.i`; overlay labels show `subagentType`/`description` instead of `agent.name`/`agent.task`. A new `emptyStyle` shows `"no agents currently running"` when there are no open dispatches — this view previously had no empty-state text at all.

- [ ] **Step 3: Run the full suite and type checker**

Run: `npm test && npx tsc -b`
Expected: all 305 tests pass (no test file for this component, matching this project's convention of no tests for presentational components). `tsc -b` will show an error here, because `GridView.tsx` (not yet rewritten) still passes the old `{ agents, projects, rate, onSelectAgent, onOpenProjects }` props. Confirm the only `tsc` error is in `GridView.tsx`, not introduced by this task's own changes to `OrchestrationGrid.tsx`. This is resolved by Task 3 — do not attempt to fix `GridView.tsx` in this task.

- [ ] **Step 4: Commit**

```bash
git add src/components/grid/OrchestrationGrid.tsx
git commit -m "feat: show real Active Agent dispatches in the Orchestration Grid"
```

---

### Task 3: Wire `GridView.tsx`, remove dead code, manual verification

**Files:**
- Modify: `src/components/grid/GridView.tsx`
- Modify: `src/components/grid/gridMath.ts`
- Modify: `src/components/grid/gridMath.test.ts`

**Interfaces:**
- Consumes: the rewritten `OrchestrationGrid` (Task 2).
- Produces: nothing new — this is the final integration point.

- [ ] **Step 1: Read the current `GridView.tsx`**

Read `src/components/grid/GridView.tsx` in full before editing.

- [ ] **Step 2: Rewrite `GridView.tsx`**

Replace the full contents of `src/components/grid/GridView.tsx` with:

```tsx
import { useAetherStore } from '../../state/store';
import { OrchestrationGrid } from './OrchestrationGrid';

export function GridView() {
  const { state, dispatch } = useAetherStore();

  return (
    <OrchestrationGrid
      agents={state.realAgents}
      rate={state.rate}
      onSelectRealAgent={(toolUseId) => {
        dispatch({ type: 'SELECT_REAL_AGENT', toolUseId });
        dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Agents' });
      }}
    />
  );
}
```

This is the click-through fix described in the spec: clicking a real dispatch node now dispatches `SELECT_REAL_AGENT` (the action the Agents view — a separate, already-shipped slice — actually reads), not the old `SELECT_AGENT`, so it correctly lands on and displays that exact dispatch's detail card. `onOpenProjects`/the `projects` prop are gone — there are no project boxes left to click.

- [ ] **Step 3: Run the full suite and type checker to confirm the view compiles**

Run: `npm test && npx tsc -b`
Expected: all 305 tests pass; `tsc -b` is now clean (no remaining errors — `OrchestrationGrid`/`GridView` are mutually consistent). If `tsc -b` is NOT clean at this point, stop and fix before proceeding to Step 4 — do not remove the dead code below while the build is still broken.

- [ ] **Step 4: Remove the now-dead fictional-agent grid functions**

Confirm (e.g. via `grep -rn "computeAgentNodes\|computeProjectNodes\|computeFeedLinks\|computeAssignmentLinks\|computeFeedStrokeWidth\b" src/` — note the word-boundary on `computeFeedStrokeWidth` so it doesn't also match `computeFeedStrokeWidthByElapsed`) that after Steps 1-3 of this task, these functions have zero remaining call sites anywhere in `src/` outside their own definitions and `gridMath.test.ts` — `OrchestrationGrid.tsx`/`GridView.tsx` have already been rewritten by Tasks 2-3 to no longer use them.

In `src/components/grid/gridMath.ts`, remove:
- The functions `computeAgentNodes`, `circularMeanAngle`, `clampBoxCenter`, `computeProjectNodes`, `computeFeedLinks`, `computeAssignmentLinks`, `computeFeedStrokeWidth` (the old share-based one — keep `computeFeedStrokeWidthByElapsed`), and `computeGridLayout` (the old one — keep `computeRealGridLayout`).
- The types `AgentNode`, `ProjectNode`, `FeedLink` (the old one — keep `RealFeedLink`), `AssignmentLink`, and `GridLayout` (the old one — keep `RealGridLayout`).
- The constants `PROJECT_RING_RADIUS`, `PROJECT_BOX_W`, `PROJECT_BOX_H` (used only by the functions just removed).
- The now-unused `import type { Agent, ProjectStub } from '../../state/types';` line, if nothing else in the file still references `Agent`/`ProjectStub` after the above removals.

Keep `VIEWBOX_W`, `VIEWBOX_H`, `HUB_X`, `HUB_Y`, `AGENT_RING_RADIUS`, `AGENT_NODE_RADIUS`, `agentAngle`, `computeViewportTransform`, `toScreenPoint`, `formatHubRate` untouched — all still used by the real-data path.

In `src/components/grid/gridMath.test.ts`, remove the `describe('computeAgentNodes', ...)`, `describe('computeFeedStrokeWidth', ...)`, `describe('computeProjectNodes', ...)`, `describe('computeFeedLinks / computeAssignmentLinks', ...)`, and `describe('computeGridLayout', ...)` blocks in full, and the `mockAgent`/`mockProject` helper functions (both become unused once those blocks are gone). Remove `computeAgentNodes, computeAssignmentLinks, computeFeedLinks, computeFeedStrokeWidth, computeGridLayout, computeProjectNodes` from the top `import { ... } from './gridMath';` line (keep `agentAngle, computeViewportTransform, formatHubRate, toScreenPoint`). Remove the now-unused `import type { Agent, ProjectStub } from '../../state/types';` line from the test file too, once `mockAgent`/`mockProject` are gone and nothing else references those types.

- [ ] **Step 5: Run the full suite and type checker**

Run: `npm test && npx tsc -b`
Expected: 289 tests pass (305 minus the 5 removed `describe` blocks' worth of tests: 2 in `computeAgentNodes`, 2 in `computeFeedStrokeWidth`, 7 in `computeProjectNodes`, 3 in `computeFeedLinks / computeAssignmentLinks`, 2 in `computeGridLayout` — 16 tests total, so 305 - 16 = 289). Count the actual removed tests from your Step 4 edit and confirm the final number matches exactly — don't assume this arithmetic is right without checking against what you actually deleted. `tsc -b` clean.

- [ ] **Step 6: Manual verification**

Run: `npm run dev` (plain browser) or `npm run electron:dev` (if available in your environment).

1. With `state.realAgents` empty (default): confirm the Grid tab shows just the hub (with its rate readout, unchanged) and the new `"no agents currently running"` empty-state message — no project boxes, no assignment links.
2. If you have access to a real Claude Code session actively dispatching subagents (this session dispatching a research/implementer subagent is sufficient, if your environment can observe it): confirm a node appears in the ring around the hub with the correct subagent-type avatar/label, a feed link from the hub whose thickness visibly increases as the dispatch's elapsed time grows; click the node and confirm it navigates to the Agents tab AND that tab shows that exact dispatch selected in its detail card (the real fix, not just "navigation happens").
3. Confirm Analytics, Files, Memory, and Chat show zero regression — all four still reference the fictional `state.agents` roster exactly as before.
4. Confirm the Projects view and Dashboard's Projects digest are unaffected — both still read the fully fictional `state.projects`.

If your environment lacks GUI/browser inspection tooling, note in your report which of the above you could not verify and that it's deferred to the controller — this project's established convention for implementers without visual tooling.

- [ ] **Step 7: Commit**

```bash
git add src/components/grid/GridView.tsx src/components/grid/gridMath.ts src/components/grid/gridMath.test.ts
git commit -m "feat: wire real Active Agent data into the Orchestration Grid; remove dead fictional-agent grid functions"
```

---

## Self-Review Notes

**Spec coverage:** Task 1 covers the new real-data layout functions, including the elapsed-time stroke-width scale grounded in `realUsageMath.ts`'s existing 10-minute constant. Task 2 covers the full component rewrite — project ring/assignment links removed, fixed accent-color nodes, subagentType/description labels, the new empty state. Task 3 covers the wiring, the explicitly-named click-through fix (`SELECT_REAL_AGENT` instead of `SELECT_AGENT`), the dead-code removal (sequenced only after the build is confirmed clean without it), and the spec's full manual verification checklist including the Projects/Analytics/Files/Memory/Chat non-regression checks. No spec section is without a task.

**Placeholder scan:** no TBD/TODO; every step has complete, runnable code or an exact command with an expected result — including the one place a plan can't know an exact number in advance (Task 3 Step 5's test count), handled by telling the implementer exactly how to verify it against what they actually deleted, not a vague placeholder.

**Type consistency:** `RealAgentNode`/`RealFeedLink`/`RealGridLayout` are defined once in Task 1 and used identically in Task 2's `OrchestrationGrid.tsx` (same field names: `toolUseId`, `agent`, `x1`/`y1`/`x2`/`y2`, `strokeWidth`). `computeRealGridLayout(agents, now)`'s signature is identical between its Task 1 test, Task 1 implementation, and Task 2's `useMemo` call. `OrchestrationGrid`'s prop rename (`onSelectAgent(name)` → `onSelectRealAgent(toolUseId)`, `agents: Agent[]` → `agents: RealAgentDispatch[]`, `projects`/`onOpenProjects` dropped) is consistent between Task 2's definition and Task 3's `GridView.tsx` call site. The `SELECT_REAL_AGENT` action (already shipped in an earlier Phase 3 slice, `{ type: 'SELECT_REAL_AGENT'; toolUseId: string }`) is dispatched with the exact same field name Task 2's `onSelectRealAgent` callback receives.
