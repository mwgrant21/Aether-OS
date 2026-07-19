import type { Agent, ProjectStub } from '../../state/types';

export const VIEWBOX_W = 1000;
export const VIEWBOX_H = 630;
export const HUB_X = 500;
export const HUB_Y = 315;
export const AGENT_RING_RADIUS = 165;
export const PROJECT_RING_RADIUS = 335;
export const PROJECT_BOX_W = 150;
export const PROJECT_BOX_H = 44;
export const AGENT_NODE_RADIUS = 31;

export interface AgentNode {
  agent: Agent;
  angle: number;
  x: number;
  y: number;
}

export interface ProjectNode {
  project: ProjectStub;
  x: number;
  y: number;
}

export interface FeedLink {
  agentName: string;
  hue: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeWidth: number;
}

export interface AssignmentLink {
  agentName: string;
  projectName: string;
  hue: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GridLayout {
  hub: { x: number; y: number };
  agentNodes: AgentNode[];
  projectNodes: ProjectNode[];
  feedLinks: FeedLink[];
  assignmentLinks: AssignmentLink[];
  agentCount: number;
  linkCount: number;
}

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

// Agent.share is the fraction of the reactor's global burn rate this agent's
// simulated token draw consumes (see tick.ts's `rate * a.share`) -- the same
// number tick.ts already uses to grow that agent's own history, so it's a
// faithful, already-live "how much is this agent drawing" signal, not a new
// metric invented for this view. Clamped defensively since a value outside
// [0, 1] (not type-enforced) would otherwise produce a degenerate or
// oversized stroke.
export function computeFeedStrokeWidth(share: number): number {
  const clamped = Math.max(0, Math.min(1, share));
  return 1.5 + clamped * 7;
}

export function computeAgentNodes(agents: Agent[]): AgentNode[] {
  const total = agents.length;
  return agents.map((agent, index) => {
    const angle = agentAngle(index, total);
    const x = HUB_X + AGENT_RING_RADIUS * Math.cos(angle);
    const y = HUB_Y + AGENT_RING_RADIUS * Math.sin(angle);
    return { agent, angle, x, y };
  });
}

// Circular mean -- averages angles via their sin/cos components rather than
// the raw radian values, so a project whose crew straddles the ring's -pi/pi
// seam doesn't get pulled toward a meaningless midpoint on the wrong side of
// the circle.
function circularMeanAngle(angles: number[]): number {
  const sumSin = angles.reduce((s, a) => s + Math.sin(a), 0);
  const sumCos = angles.reduce((s, a) => s + Math.cos(a), 0);
  return Math.atan2(sumSin, sumCos);
}

function clampBoxCenter(x: number, y: number): { x: number; y: number } {
  const halfW = PROJECT_BOX_W / 2;
  const halfH = PROJECT_BOX_H / 2;
  return {
    x: Math.min(VIEWBOX_W - halfW, Math.max(halfW, x)),
    y: Math.min(VIEWBOX_H - halfH, Math.max(halfH, y)),
  };
}

// Each project first wants to sit at the circular mean angle of its crew (so
// it visually clusters near the agents working it); then every project is
// re-snapped onto evenly-spaced slots around the ring, anchored at the
// SMALLEST desired angle in the set (not a fixed reference point) and sorted
// by that desired angle -- so a single, uncontested project lands exactly on
// its own crew's angle, while two or more projects wanting the same spot
// still separate cleanly. A project with no crew currently in the active
// roster (crew list empty, or every named crew member idle/terminated) falls
// back to an even index-based spread -- deterministic, and only ever affects
// tie-breaking in the sort, since the slot-snapping pass discards the exact
// desired angle beyond ordering.
export function computeProjectNodes(agentNodes: AgentNode[], projects: ProjectStub[]): ProjectNode[] {
  const total = projects.length;
  if (!total) return [];

  const angleByAgentName = new Map(agentNodes.map((n) => [n.agent.name, n.angle]));

  const withDesiredAngle = projects.map((project, index) => {
    const crewAngles = (project.crew ?? [])
      .map((name) => angleByAgentName.get(name))
      .filter((a): a is number => a !== undefined);
    const desiredAngle = crewAngles.length ? circularMeanAngle(crewAngles) : agentAngle(index, total);
    return { project, index, desiredAngle };
  });

  const sortedByDesired = [...withDesiredAngle].sort((a, b) => a.desiredAngle - b.desiredAngle);
  const anchor = sortedByDesired[0].desiredAngle;
  const slotAngleByIndex = new Map<number, number>();
  sortedByDesired.forEach((entry, slot) => {
    slotAngleByIndex.set(entry.index, anchor + (slot * 2 * Math.PI) / total);
  });

  return projects.map((project, index) => {
    const angle = slotAngleByIndex.get(index)!;
    const rawX = HUB_X + PROJECT_RING_RADIUS * Math.cos(angle);
    const rawY = HUB_Y + PROJECT_RING_RADIUS * Math.sin(angle);
    const { x, y } = clampBoxCenter(rawX, rawY);
    return { project, x, y };
  });
}

export function computeFeedLinks(agentNodes: AgentNode[]): FeedLink[] {
  return agentNodes.map((n) => ({
    agentName: n.agent.name,
    hue: n.agent.hue,
    x1: HUB_X,
    y1: HUB_Y,
    x2: n.x,
    y2: n.y,
    strokeWidth: computeFeedStrokeWidth(n.agent.share),
  }));
}

// Only drawn for crew members who are still in the active roster -- a
// project can keep listing a crew member by name after that agent is
// paused, killed, or reactivated under someone else's slot; a stale name
// with no matching node simply produces no link rather than a broken one
// pointing nowhere.
export function computeAssignmentLinks(agentNodes: AgentNode[], projectNodes: ProjectNode[]): AssignmentLink[] {
  const nodeByAgentName = new Map(agentNodes.map((n) => [n.agent.name, n]));
  const links: AssignmentLink[] = [];
  for (const pNode of projectNodes) {
    for (const crewName of pNode.project.crew ?? []) {
      const aNode = nodeByAgentName.get(crewName);
      if (!aNode) continue;
      links.push({
        agentName: crewName,
        projectName: pNode.project.name,
        hue: pNode.project.hue,
        x1: aNode.x,
        y1: aNode.y,
        x2: pNode.x,
        y2: pNode.y,
      });
    }
  }
  return links;
}

export function computeGridLayout(agents: Agent[], projects: ProjectStub[]): GridLayout {
  const agentNodes = computeAgentNodes(agents);
  const projectNodes = computeProjectNodes(agentNodes, projects);
  const feedLinks = computeFeedLinks(agentNodes);
  const assignmentLinks = computeAssignmentLinks(agentNodes, projectNodes);
  return {
    hub: { x: HUB_X, y: HUB_Y },
    agentNodes,
    projectNodes,
    feedLinks,
    assignmentLinks,
    agentCount: agents.length,
    linkCount: feedLinks.length + assignmentLinks.length,
  };
}

export function formatHubRate(rate: number): string {
  return `${Math.round(rate / 1000)}K tok/min`;
}
