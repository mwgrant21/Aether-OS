import { describe, expect, it } from 'vitest';
import {
  agentAngle,
  computeAgentNodes,
  computeAssignmentLinks,
  computeFeedLinks,
  computeFeedStrokeWidth,
  computeGridLayout,
  computeProjectNodes,
  computeViewportTransform,
  formatHubRate,
  toScreenPoint,
} from './gridMath';
import type { Agent, ProjectStub } from '../../state/types';

function mockAgent(name: string, share = 0.2, hue = '#7ef0ff'): Agent {
  return { i: name.slice(0, 2).toUpperCase(), name, task: 'Working', pct: 50, hue, eta: '5m', share, hist: [], files: [] };
}

function mockProject(name: string, crew: string[], hue = '#7ef0ff'): ProjectStub {
  return { name, status: 'BUILDING', pct: 50, hue, crew };
}

describe('agentAngle', () => {
  it("starts at 12 o'clock (-pi/2) for index 0", () => {
    expect(agentAngle(0, 4)).toBeCloseTo(-Math.PI / 2);
  });

  it('distributes evenly clockwise around the circle', () => {
    expect(agentAngle(1, 4)).toBeCloseTo(0);
    expect(agentAngle(2, 4)).toBeCloseTo(Math.PI / 2);
    expect(agentAngle(3, 4)).toBeCloseTo(Math.PI);
  });

  it('never divides by zero when total is 0', () => {
    expect(Number.isFinite(agentAngle(0, 0))).toBe(true);
    expect(agentAngle(0, 0)).toBeCloseTo(-Math.PI / 2);
  });
});

describe('computeAgentNodes', () => {
  it('places 4 agents evenly on the 165-radius ring around the (500, 315) hub', () => {
    const nodes = computeAgentNodes([mockAgent('A0'), mockAgent('A1'), mockAgent('A2'), mockAgent('A3')]);
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

  it('returns an empty array with zero agents instead of dividing by zero', () => {
    expect(computeAgentNodes([])).toEqual([]);
  });
});

describe('computeViewportTransform', () => {
  it('has zero letterbox and unit scale when the container matches the viewBox aspect ratio exactly', () => {
    const t = computeViewportTransform(1000, 630);
    expect(t.scale).toBeCloseTo(1);
    expect(t.offsetX).toBeCloseTo(0);
    expect(t.offsetY).toBeCloseTo(0);
  });

  it('letterboxes horizontally when the container is proportionally wider than the viewBox', () => {
    // Regression fixture: measured live in Chrome at a real Grid panel size
    // (containerRatio 1.882 vs the viewBox's 1.587) where labels visibly
    // detached from their SVG circles before this fix.
    const t = computeViewportTransform(1264.666748046875, 672);
    expect(t.scale).toBeCloseTo(672 / 630);
    expect(t.offsetX).toBeCloseTo(99, 0);
    expect(t.offsetY).toBeCloseTo(0);
  });

  it('letterboxes vertically when the container is proportionally taller than the viewBox', () => {
    const t = computeViewportTransform(500, 630);
    expect(t.scale).toBeCloseTo(500 / 1000);
    expect(t.offsetX).toBeCloseTo(0);
    expect(t.offsetY).toBeGreaterThan(0);
  });

  it('returns a zero transform for an unmeasured (zero-size) container instead of dividing by zero', () => {
    expect(computeViewportTransform(0, 0)).toEqual({ scale: 0, offsetX: 0, offsetY: 0 });
  });
});

describe('toScreenPoint', () => {
  it('maps the hub (500,315) to the exact container center regardless of letterbox direction', () => {
    const t = computeViewportTransform(1264.666748046875, 672);
    const { screenX, screenY } = toScreenPoint(500, 315, t);
    expect(screenX).toBeCloseTo(1264.666748046875 / 2, 1);
    expect(screenY).toBeCloseTo(672 / 2, 1);
  });

  it('matches the measured real-browser screen position for a right-side agent node under horizontal letterbox', () => {
    const t = computeViewportTransform(1264.666748046875, 672);
    const { screenX } = toScreenPoint(665, 315, t);
    expect(screenX).toBeCloseTo(808.33, 1);
  });
});

describe('computeFeedStrokeWidth', () => {
  it('scales linearly between a 1.5 floor and an 8.5 ceiling', () => {
    expect(computeFeedStrokeWidth(0)).toBeCloseTo(1.5);
    expect(computeFeedStrokeWidth(1)).toBeCloseTo(8.5);
    expect(computeFeedStrokeWidth(0.22)).toBeCloseTo(3.04);
  });

  it('clamps out-of-range shares instead of producing a degenerate stroke', () => {
    expect(computeFeedStrokeWidth(-1)).toBeCloseTo(1.5);
    expect(computeFeedStrokeWidth(2)).toBeCloseTo(8.5);
  });
});

describe('computeProjectNodes', () => {
  it('anchors a single, uncontested project at the circular mean angle of its crew', () => {
    const agents = [mockAgent('A0'), mockAgent('A1'), mockAgent('A2'), mockAgent('A3')];
    const agentNodes = computeAgentNodes(agents);
    const [node] = computeProjectNodes(agentNodes, [mockProject('P', ['A0', 'A1'])]);
    const expectedAngle = -Math.PI / 4; // circular mean of A0's -90 deg and A1's 0 deg
    expect(node.x).toBeCloseTo(500 + 335 * Math.cos(expectedAngle));
    expect(node.y).toBeCloseTo(315 + 335 * Math.sin(expectedAngle));
  });

  it('assigns slots by sorted desired angle, not by project array order', () => {
    // 3 agents at -90, 30, 150 degrees. Project 0 (first in the array) is
    // crewed by the agent at the LARGEST angle (150); project 1 by the
    // smallest (-90); project 2 by the middle (30) -- the reverse of index order.
    const agents = [mockAgent('A0'), mockAgent('A1'), mockAgent('A2')];
    const agentNodes = computeAgentNodes(agents);
    const nodes = computeProjectNodes(agentNodes, [
      mockProject('LargestDesired', ['A2']),
      mockProject('SmallestDesired', ['A0']),
      mockProject('MiddleDesired', ['A1']),
    ]);
    // The three desired angles are already evenly spaced by construction, so
    // sorting + re-spacing lands each project exactly back on its own crew's
    // angle -- proof slot assignment tracks sorted desired angle rather than
    // blindly assigning slot[i] = project[i].
    expect(nodes[1].x).toBeCloseTo(500); // SmallestDesired -> -90 deg
    expect(nodes[1].y).toBeCloseTo(22); // clamped from y=-20
    expect(nodes[2].x).toBeCloseTo(790.119, 2); // MiddleDesired -> 30 deg
    expect(nodes[2].y).toBeCloseTo(482.5, 2);
    expect(nodes[0].x).toBeCloseTo(209.881, 2); // LargestDesired -> 150 deg
    expect(nodes[0].y).toBeCloseTo(482.5, 2);
  });

  it('separates two projects that want the exact same angle into distinct slots', () => {
    const agentNodes = computeAgentNodes([mockAgent('A0')]); // sole agent at -90 deg
    const nodes = computeProjectNodes(agentNodes, [mockProject('P1', ['A0']), mockProject('P2', ['A0'])]);
    expect(nodes[0].x).toBeCloseTo(500);
    expect(nodes[0].y).toBeCloseTo(22);
    expect(nodes[1].x).toBeCloseTo(500);
    expect(nodes[1].y).toBeCloseTo(608);
  });

  it('clamps a box center to stay inside the 1000x630 viewBox at the ring extremes', () => {
    const agentNodes = computeAgentNodes([mockAgent('A0')]); // sits at 12 o'clock
    const [node] = computeProjectNodes(agentNodes, [mockProject('P', ['A0'])]);
    // Raw placement at radius 335 from a y=315 hub would put this box's
    // center at y=-20 -- off the top edge before clamping to half its 44px height.
    expect(node.x).toBeCloseTo(500);
    expect(node.y).toBeCloseTo(22);
  });

  it('falls back to a deterministic index-based angle when no crew member is in the active roster', () => {
    const agentNodes = computeAgentNodes([mockAgent('A0')]);
    const nodes = computeProjectNodes(agentNodes, [mockProject('Orphaned', ['Nobody Here'])]);
    expect(nodes).toHaveLength(1);
    expect(Number.isFinite(nodes[0].x)).toBe(true);
    expect(Number.isFinite(nodes[0].y)).toBe(true);
  });

  it('returns an empty array with zero projects', () => {
    expect(computeProjectNodes(computeAgentNodes([mockAgent('A0')]), [])).toEqual([]);
  });

  it('tolerates a project with no crew field at all (legacy persisted data predating ProjectStub.crew) instead of throwing', () => {
    const agentNodes = computeAgentNodes([mockAgent('A0')]);
    const legacyProject = { name: 'Legacy', status: 'BUILDING' as const, pct: 10, hue: '#fff' } as ProjectStub;
    const nodes = computeProjectNodes(agentNodes, [legacyProject]);
    expect(nodes).toHaveLength(1);
    expect(Number.isFinite(nodes[0].x)).toBe(true);
    expect(Number.isFinite(nodes[0].y)).toBe(true);
  });
});

describe('computeFeedLinks / computeAssignmentLinks', () => {
  it("draws one feed link per agent from the hub, widened by that agent's share", () => {
    const agentNodes = computeAgentNodes([mockAgent('A0', 0.22, '#7ef0ff')]);
    const [link] = computeFeedLinks(agentNodes);
    expect(link.x1).toBe(500);
    expect(link.y1).toBe(315);
    expect(link.x2).toBeCloseTo(agentNodes[0].x);
    expect(link.y2).toBeCloseTo(agentNodes[0].y);
    expect(link.strokeWidth).toBeCloseTo(3.04);
    expect(link.hue).toBe('#7ef0ff');
  });

  it('draws an assignment link only for crew still present in the active roster', () => {
    const agentNodes = computeAgentNodes([mockAgent('A0')]);
    const projectNodes = computeProjectNodes(agentNodes, [mockProject('P', ['A0', 'Ghost Agent'], '#ff6b7a')]);
    const links = computeAssignmentLinks(agentNodes, projectNodes);
    expect(links).toHaveLength(1);
    expect(links[0].agentName).toBe('A0');
    expect(links[0].hue).toBe('#ff6b7a');
  });

  it('produces no assignment links, without throwing, for a legacy project with no crew field at all', () => {
    const agentNodes = computeAgentNodes([mockAgent('A0')]);
    const legacyProject = { name: 'Legacy', status: 'BUILDING' as const, pct: 10, hue: '#fff' } as ProjectStub;
    const projectNodes = computeProjectNodes(agentNodes, [legacyProject]);
    expect(computeAssignmentLinks(agentNodes, projectNodes)).toEqual([]);
  });
});

describe('computeGridLayout', () => {
  it('composes agent/project nodes and links, deriving header stats from them', () => {
    const agents = [mockAgent('A0'), mockAgent('A1')];
    const projects = [mockProject('P0', ['A0'])];
    const layout = computeGridLayout(agents, projects);
    expect(layout.agentCount).toBe(2);
    expect(layout.linkCount).toBe(layout.feedLinks.length + layout.assignmentLinks.length);
    expect(layout.linkCount).toBe(3); // 2 feeds + 1 assignment
  });

  it('renders just the hub, with no rings or links, for a spawn-free session with no projects', () => {
    const layout = computeGridLayout([], []);
    expect(layout.hub).toEqual({ x: 500, y: 315 });
    expect(layout.agentNodes).toEqual([]);
    expect(layout.projectNodes).toEqual([]);
    expect(layout.feedLinks).toEqual([]);
    expect(layout.assignmentLinks).toEqual([]);
    expect(layout.agentCount).toBe(0);
    expect(layout.linkCount).toBe(0);
  });
});

describe('formatHubRate', () => {
  it('formats the live burn rate as a rounded K tok/min readout', () => {
    expect(formatHubRate(92000)).toBe('92K tok/min');
    expect(formatHubRate(92549)).toBe('93K tok/min');
  });
});
