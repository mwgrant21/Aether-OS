import type { RealAgentDispatch } from '../../state/liveAgentsMath';

export const VIEWBOX_W = 1000;
export const VIEWBOX_H = 630;
export const HUB_X = 500;
export const HUB_Y = 315;
export const AGENT_RING_RADIUS = 165;
export const AGENT_NODE_RADIUS = 31;

export interface ViewportTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

// Mirrors the browser's own preserveAspectRatio="xMidYMid meet" scaling, so
// the HTML-overlay labels (hub/agent/project name+status text -- kept as
// HTML rather than SVG <text> for CSS ellipsis truncation) land in the same
// screen pixels as their SVG counterparts. A container whose aspect ratio
// doesn't exactly match the 1000x630 viewBox (true for almost any real
// window size, since this panel resizes with the rest of the app's chrome)
// gets letterboxed by "meet" -- naive percentage-of-container positioning
// ignores that letterbox and drifts in proportion to distance from the hub,
// which is why left/right agents visibly detached from their circles while
// the hub label (dead center, unaffected by centered scaling) did not.
export function computeViewportTransform(containerWidth: number, containerHeight: number): ViewportTransform {
  if (containerWidth <= 0 || containerHeight <= 0) return { scale: 0, offsetX: 0, offsetY: 0 };
  const scale = Math.min(containerWidth / VIEWBOX_W, containerHeight / VIEWBOX_H);
  return {
    scale,
    offsetX: (containerWidth - VIEWBOX_W * scale) / 2,
    offsetY: (containerHeight - VIEWBOX_H * scale) / 2,
  };
}

export function toScreenPoint(x: number, y: number, transform: ViewportTransform): { screenX: number; screenY: number } {
  return { screenX: transform.offsetX + x * transform.scale, screenY: transform.offsetY + y * transform.scale };
}

// 12 o'clock start (-pi/2), evenly distributed clockwise. With zero agents
// this still returns a defined angle (never actually rendered, since
// agentNodes ends up empty) rather than producing NaN.
export function agentAngle(index: number, total: number): number {
  if (total <= 0) return -Math.PI / 2;
  return -Math.PI / 2 + (index * 2 * Math.PI) / total;
}

export function formatHubRate(rate: number): string {
  return `${Math.round(rate / 1000)}K tok/min`;
}

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
// dispatch's feed link thickens toward the same 1.5-8.5 range the old
// share-based stroke width used, reaching the max once the dispatch has
// been running about as long as that already-established "significant"
// window, rather than an arbitrary new cutoff. Not an actual import, since
// BURN_WINDOW_MIN is a private const in a different file.
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
