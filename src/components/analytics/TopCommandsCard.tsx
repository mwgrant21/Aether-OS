import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { computeTopCommands } from './analyticsMath';

export function TopCommandsCard() {
  const { state } = useAetherStore();
  const rows = computeTopCommands(state.cmdHist);
  const maxCount = rows[0]?.count ?? 1;

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>TOP COMMANDS</div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 9 }}>
        {rows.map((r, i) => (
          <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, width: 12 }}>{i + 1}</span>
            <span style={{ font: `600 12px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textBody, width: 58 }}>{r.name}</span>
            <span style={{ flex: 1, height: 5, borderRadius: 3, background: 'rgba(20,50,64,.7)', overflow: 'hidden' }}>
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${(r.count / maxCount) * 100}%`,
                  background: 'linear-gradient(90deg,#0f7f97,#7ef0ff)',
                  boxShadow: '0 0 8px rgba(95,240,255,.5)',
                }}
              />
            </span>
            <span style={{ font: `700 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft, width: 34, textAlign: 'right' }}>{r.count}×</span>
          </div>
        ))}
        {!rows.length && <div style={emptyStyle}>no commands run yet</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
