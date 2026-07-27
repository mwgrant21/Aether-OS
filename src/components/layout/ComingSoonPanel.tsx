import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';

export function ComingSoonPanel({ tabName }: { tabName: string }) {
  const colors = useColors();
  return (
    <div style={rootStyle(colors)}>
      <div style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textSecondary }}>{tabName.toUpperCase()}</div>
      <div style={{ marginTop: 8, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textMuted }}>
        This view is not built yet — only Terminal is implemented in this pass.
      </div>
    </div>
  );
}

function rootStyle(colors: ColorPalette): CSSProperties {
  return {
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
}
