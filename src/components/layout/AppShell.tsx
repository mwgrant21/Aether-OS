import type { CSSProperties, ReactNode } from 'react';
import { colors } from '../../styles/tokens';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { Footer } from './Footer';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div style={pageStyle}>
      <div style={frameStyle}>
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
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: colors.pageRadial,
};
const frameStyle: CSSProperties = { width: 1536, height: 1024, display: 'flex', flexDirection: 'column', overflow: 'hidden' };
const contentStyle: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 };
