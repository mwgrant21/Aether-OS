import { useMemo, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import type { Agent, ProjectStub } from '../../state/types';
import { AGENT_NODE_RADIUS, computeGridLayout, formatHubRate, type AgentNode, type ProjectNode } from './gridMath';

interface OrchestrationGridProps {
  agents: Agent[];
  projects: ProjectStub[];
  rate: number;
  onSelectAgent: (name: string) => void;
  onOpenProjects: () => void;
}

export function OrchestrationGrid({ agents, projects, rate, onSelectAgent, onOpenProjects }: OrchestrationGridProps) {
  const layout = useMemo(() => computeGridLayout(agents, projects), [agents, projects]);

  return (
    <div style={rootStyle}>
      <div style={headerStyle}>
        <div style={titleStyle}>ORCHESTRATION GRID</div>
        <div style={statsStyle}>
          {layout.agentCount} AGENTS · {layout.linkCount} LINKS
        </div>
      </div>

      <div style={sceneStyle}>
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

          {layout.assignmentLinks.map((link) => (
            <line
              key={`${link.agentName}->${link.projectName}`}
              x1={link.x1}
              y1={link.y1}
              x2={link.x2}
              y2={link.y2}
              stroke={link.hue}
              strokeWidth={1.4}
              strokeDasharray="3 10"
              strokeOpacity={0.55}
              style={{ animation: 'dashFlowRev 2.6s linear infinite' }}
            />
          ))}

          {layout.feedLinks.map((link) => (
            <line
              key={link.agentName}
              x1={link.x1}
              y1={link.y1}
              x2={link.x2}
              y2={link.y2}
              stroke={link.hue}
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

          {layout.projectNodes.map((node) => (
            <rect
              key={node.project.name}
              x={node.x - 75}
              y={node.y - 22}
              width={150}
              height={44}
              rx={10}
              fill="rgba(6,20,28,.6)"
              stroke={node.project.hue}
              strokeWidth={1.5}
              onClick={onOpenProjects}
              style={{ cursor: 'pointer' }}
            />
          ))}

          {layout.agentNodes.map((node) => (
            <g key={node.agent.name} onClick={() => onSelectAgent(node.agent.name)} style={{ cursor: 'pointer' }}>
              <circle cx={node.x} cy={node.y} r={AGENT_NODE_RADIUS} fill="rgba(6,20,28,.65)" stroke={node.agent.hue} strokeWidth={2} />
              <circle cx={node.x} cy={node.y} r={6} fill={node.agent.hue} style={{ filter: `drop-shadow(0 0 6px ${node.agent.hue})` }} />
              <text x={node.x} y={node.y} textAnchor="middle" dominantBaseline="central" style={{ font: `700 13px ${fonts.mono}`, fill: node.agent.hue }}>
                {node.agent.i}
              </text>
            </g>
          ))}
        </svg>

        <div style={overlayStyle}>
          <div style={hubLabelWrapStyle(layout.hub.x, layout.hub.y)}>
            <div style={hubNameStyle}>AETHER CORE</div>
            <div style={hubRateStyle}>{formatHubRate(rate)}</div>
          </div>

          {layout.agentNodes.map((node: AgentNode) => (
            <div key={node.agent.name} style={agentLabelWrapStyle(node)}>
              <div style={agentNameStyle}>{node.agent.name}</div>
              <div style={agentRoleStyle}>{node.agent.task}</div>
            </div>
          ))}

          {layout.projectNodes.map((node: ProjectNode) => (
            <div key={node.project.name} style={projectLabelWrapStyle(node)}>
              <div style={projectNameStyle}>{node.project.name}</div>
              <div style={{ ...projectMetaStyle, color: node.project.hue }}>
                {node.project.status} · {node.project.pct}%
              </div>
            </div>
          ))}
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

function hubLabelWrapStyle(x: number, y: number): CSSProperties {
  return {
    position: 'absolute',
    left: `${(x / 1000) * 100}%`,
    top: `${(y / 630) * 100}%`,
    transform: 'translate(-50%, 34px)',
    textAlign: 'center',
  };
}
const hubNameStyle: CSSProperties = { font: `700 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textPrimary };
const hubRateStyle: CSSProperties = { marginTop: 4, font: `400 10px/1 ${fonts.mono}`, color: colors.accentCyanSoft };

function agentLabelWrapStyle(node: AgentNode): CSSProperties {
  return {
    position: 'absolute',
    left: `${node.xPct}%`,
    top: `${node.yPct}%`,
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

function projectLabelWrapStyle(node: ProjectNode): CSSProperties {
  return {
    position: 'absolute',
    left: `${node.xPct}%`,
    top: `${node.yPct}%`,
    transform: 'translate(-50%, -50%)',
    width: 140,
    textAlign: 'center',
  };
}
const projectNameStyle: CSSProperties = {
  font: `600 11px/1 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const projectMetaStyle: CSSProperties = { marginTop: 3, font: `700 10px/1 ${fonts.mono}` };
