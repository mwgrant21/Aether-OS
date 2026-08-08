import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { SessionCostCard } from '../ledger/SessionCostCard';
import { RollupCard } from '../ledger/RollupCard';
import { CacheImpactCard } from '../ledger/CacheImpactCard';
import type { ProjectNode } from '../../shared/projectsSnapshot';

export function ProjectDetailCard({ node }: { node: ProjectNode | null }) {
  const colors = useColors();
  if (!node) return <div style={emptyStyle(colors)}>Select a project to see its cost.</div>;

  return (
    <div style={rootStyle}>
      <div style={headerStyle(colors)}>
        {node.name}
        {node.worktree !== null && <span style={wtStyle(colors)}>worktree: {node.worktree}</span>}
      </div>
      <SessionCostCard total={node.ledger.total} tiers={node.ledger.tiers} />
      <RollupCard rollups={node.ledger.rollups} />
      <CacheImpactCard cache={node.ledger.cache} hitRatio={node.ledger.cacheHitRate} />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' };

const headerStyle = (c: ColorPalette): CSSProperties => ({
  font: `700 18px/1 ${fonts.ui}`,
  color: c.textPrimary,
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
});

const wtStyle = (c: ColorPalette): CSSProperties => ({
  font: `500 11px/1 ${fonts.mono}`,
  color: c.textMuted,
});

const emptyStyle = (c: ColorPalette): CSSProperties => ({
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  font: `400 12px/1.5 ${fonts.ui}`,
  color: c.textDim,
});
