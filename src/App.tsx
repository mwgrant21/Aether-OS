import { colors, fonts } from './styles/tokens';

export default function App() {
  return (
    <div style={rootStyle}>
      <div style={{ font: `700 20px/1 ${fonts.ui}`, letterSpacing: 5, color: colors.textPrimary }}>
        AETHER<span style={{ color: colors.textMuted, fontWeight: 500 }}> OS</span>
      </div>
      <div style={{ marginTop: 12, font: `400 12px/1 ${fonts.mono}`, color: colors.textMuted }}>booting…</div>
    </div>
  );
}

const rootStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  background: colors.pageRadial,
};
