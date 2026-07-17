import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';

export function ComingSoonPanel({ tabName }: { tabName: string }) {
  return (
    <div style={rootStyle}>
      <div style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textSecondary }}>{tabName.toUpperCase()}</div>
      <div style={{ marginTop: 8, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textMuted }}>
        This view is not built yet — only Terminal is implemented in this pass.
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = {
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
