import type { CSSProperties, ReactNode } from 'react';
import { colors } from '../../styles/tokens';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { Footer } from './Footer';
import { useViewportScale } from './useViewportScale';

export function AppShell({ children }: { children: ReactNode }) {
  const scale = useViewportScale();
  return (
    <div style={pageStyle}>
      <div style={{ ...frameStyle, transform: `scale(${scale})`, transformOrigin: 'center center' }}>
        <TopBar />
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <Sidebar />
          <div style={contentStyle}>{children}</div>
        </div>
        <Footer />
      </div>
    </div>
  );
}

const pageStyle: CSSProperties = {
  width: '100vw',
  height: '100vh',
  overflow: 'hidden',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: colors.pageRadial,
};
const frameStyle: CSSProperties = { width: 1536, height: 1024, display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 };
const contentStyle: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 };
