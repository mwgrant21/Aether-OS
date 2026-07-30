import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import type { RealActiveWork } from '../../state/liveAgentsMath';
import type { Anomaly } from '../../shared/anomalyDetectors';
import {
  AGENT_NODE_RADIUS,
  WARNING_RING_DASH_PATTERN,
  WARNING_RING_RADIUS_OFFSET,
  WARNING_RING_STROKE_WIDTH,
  computeRealGridLayout,
  computeViewportTransform,
  formatHubRate,
  toScreenPoint,
  type RealAgentNode,
  type ViewportTransform,
} from './gridMath';

interface OrchestrationGridProps {
  agents: RealActiveWork[];
  rate: number;
  anomalies: Anomaly[];
  onSelectRealAgent: (toolUseId: string) => void;
}

export function OrchestrationGrid({ agents, rate, anomalies, onSelectRealAgent }: OrchestrationGridProps) {
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
          {layout.agentCount} ACTIVE · {layout.linkCount} LINKS
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

          {layout.agentNodes.map((node) => {
            const flagged = !!node.agent.toolUseId && anomalies.some((a) => a.toolUseId === node.agent.toolUseId);
            return (
            <g
              key={node.agent.toolUseId}
              onClick={() => onSelectRealAgent(node.agent.toolUseId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectRealAgent(node.agent.toolUseId);
                }
              }}
              tabIndex={0}
              role="button"
              aria-label={node.agent.label}
              style={{ cursor: 'pointer' }}
            >
              {flagged && (
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={AGENT_NODE_RADIUS + WARNING_RING_RADIUS_OFFSET}
                  fill="none"
                  stroke={colors.warn}
                  strokeWidth={WARNING_RING_STROKE_WIDTH}
                  strokeDasharray={WARNING_RING_DASH_PATTERN}
                  style={{ animation: 'blink 1s step-end infinite' }}
                />
              )}
              <circle cx={node.x} cy={node.y} r={AGENT_NODE_RADIUS} fill="rgba(6,20,28,.65)" stroke={colors.accentCyanSoft} strokeWidth={2} />
              <circle cx={node.x} cy={node.y} r={6} fill={colors.accentCyanSoft} style={{ filter: `drop-shadow(0 0 6px ${colors.accentCyanSoft})` }} />
              <text
                x={node.x}
                y={node.y}
                textAnchor="middle"
                dominantBaseline="central"
                style={{ font: `700 13px ${fonts.mono}`, fill: colors.accentCyanSoft }}
              >
                {node.agent.label.slice(0, 2).toUpperCase()}
              </text>
            </g>
            );
          })}
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
                  <div style={agentNameStyle}>{node.agent.label}</div>
                  <div style={agentRoleStyle}>{node.agent.description}</div>
                </div>
              ))}
            </>
          )}
          {!layout.agentNodes.length && <div style={emptyStyle}>nothing running</div>}
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
