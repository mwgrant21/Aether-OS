import { describe, expect, it } from 'vitest';
import {
  agentAngle,
  computeViewportTransform,
  formatHubRate,
  toScreenPoint,
  computeRealAgentNodes,
  computeFeedStrokeWidthByElapsed,
  computeRealFeedLinks,
  computeRealGridLayout,
} from './gridMath';
import type { RealAgentDispatch } from '../../state/liveAgentsMath';

function mockRealAgent(toolUseId: string, startedAt: string, subagentType = 'general-purpose'): RealAgentDispatch {
  return { toolUseId, subagentType, description: 'Working', startedAt, prompt: 'do work', model: null };
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

describe('formatHubRate', () => {
  it('formats the live burn rate as a rounded K tok/min readout', () => {
    expect(formatHubRate(92000)).toBe('92K tok/min');
    expect(formatHubRate(92549)).toBe('93K tok/min');
  });
});

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
