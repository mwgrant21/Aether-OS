import { useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { usdPrecise } from '../ledger/format';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';

export function ProjectRosterCard({
  snapshot,
  selectedKey,
  onSelect,
}: {
  snapshot: ProjectsSnapshot | null;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const colors = useColors();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (!snapshot || snapshot.roots.length === 0) {
    return (
      <div style={cardStyle(colors)}>
        <div style={titleStyle(colors)}>PROJECTS</div>
        <div style={emptyStyle(colors)}>No projects observed yet.</div>
      </div>
    );
  }

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>PROJECTS</div>

      {snapshot.roots.map((root) => {
        // Only offer disclosure when there is genuinely more than one checkout;
        // otherwise the single child is identical to its parent.
        const expandable = root.children.length > 1;
        const isOpen = expanded.has(root.key);
        return (
          <div key={root.key}>
            <div style={rowStyle(colors, root.key === selectedKey)}>
              {expandable ? (
                <Button
                  onClick={() => toggle(root.key)}
                  style={caretStyle(colors)}
                  aria-label={`expand ${root.name}`}
                >
                  {isOpen ? '▾' : '▸'}
                </Button>
              ) : (
                <span style={caretSpacerStyle} />
              )}
              <Button onClick={() => onSelect(root.key)} style={nameStyle(colors)}>
                {root.name}
              </Button>
              <span style={costStyle(colors)}>{usdPrecise(root.ledger.total.usd)}</span>
            </div>

            {expandable &&
              isOpen &&
              root.children.map((child) => (
                <div key={child.key} style={childRowStyle(colors, child.key === selectedKey)}>
                  <Button onClick={() => onSelect(child.key)} style={childNameStyle(colors)}>
                    {child.worktree === null ? 'main' : child.worktree}
                  </Button>
                  <span style={costStyle(colors)}>{usdPrecise(child.ledger.total.usd)}</span>
                </div>
              ))}
          </div>
        );
      })}

      {snapshot.unscoped && (
        <div style={rowStyle(colors, false)}>
          <span style={caretSpacerStyle} />
          <span
            style={unscopedNameStyle(colors)}
            title="Work done outside any git repository — most often from the home directory. Not an error."
          >
            unscoped — work outside any git repository
          </span>
          <span style={costStyle(colors)}>{usdPrecise(snapshot.unscoped.total.usd)}</span>
        </div>
      )}
    </div>
  );
}

const cardStyle = (c: ColorPalette): CSSProperties => ({
  width: 300,
  flex: 'none',
  padding: '15px',
  borderRadius: 14,
  border: `1px solid ${c.panelBorder}`,
  background: c.panelGradient,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
});

const titleStyle = (c: ColorPalette): CSSProperties => ({
  font: `600 12px/1 ${fonts.ui}`,
  letterSpacing: '3px',
  color: c.textSecondary,
  marginBottom: 12,
});

const rowStyle = (c: ColorPalette, isSelected: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 9px',
  borderRadius: 9,
  cursor: 'pointer',
  background: isSelected ? `${c.activeBorder}14` : undefined,
  border: isSelected ? `1px solid ${c.activeBorder}` : '1px solid transparent',
  marginTop: 8,
});

const childRowStyle = (c: ColorPalette, isSelected: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '6px 9px 6px 32px',
  borderRadius: 6,
  cursor: 'pointer',
  background: isSelected ? `${c.activeBorder}14` : undefined,
  border: isSelected ? `1px solid ${c.activeBorder}` : '1px solid transparent',
});

const caretStyle = (c: ColorPalette): CSSProperties => ({
  flex: 'none',
  width: 20,
  height: 20,
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  font: `600 12px/1 ${fonts.ui}`,
  color: c.textMuted,
  cursor: 'pointer',
  border: 'none',
  background: 'none',
});

const caretSpacerStyle: CSSProperties = {
  flex: 'none',
  width: 20,
};

const nameStyle = (c: ColorPalette): CSSProperties => ({
  flex: 1,
  font: `600 13px/1 ${fonts.ui}`,
  color: c.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  textAlign: 'left',
  padding: 0,
  border: 'none',
  background: 'none',
  cursor: 'pointer',
});

const childNameStyle = (c: ColorPalette): CSSProperties => ({
  flex: 1,
  font: `500 12px/1 ${fonts.ui}`,
  color: c.textBody,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  textAlign: 'left',
  padding: 0,
  border: 'none',
  background: 'none',
  cursor: 'pointer',
});

const costStyle = (c: ColorPalette): CSSProperties => ({
  flex: 'none',
  font: `600 12px/1 ${fonts.mono}`,
  color: c.textMuted,
  whiteSpace: 'nowrap',
});

const unscopedNameStyle = (c: ColorPalette): CSSProperties => ({
  flex: 1,
  font: `500 11px/1.4 ${fonts.ui}`,
  color: c.textMuted,
});

const emptyStyle = (c: ColorPalette): CSSProperties => ({
  font: `400 11px/1.4 ${fonts.ui}`,
  color: c.textDim,
  padding: '12px 0',
});
