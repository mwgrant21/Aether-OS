import { useState, type CSSProperties, type ReactNode } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { Footer } from './Footer';
import { useViewportScale } from './useViewportScale';

export const MAIN_CONTENT_ID = 'main-content';

export function AppShell({ children }: { children: ReactNode }) {
  const scale = useViewportScale();
  const colors = useColors();
  return (
    <div style={pageStyle(colors)}>
      <div style={{ ...frameStyle, transform: `scale(${scale})`, transformOrigin: 'center center' }}>
        <SkipLink colors={colors} />
        <TopBar />
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <Sidebar />
          {/* tabIndex=-1 makes this a valid fragment-navigation focus target
              without adding it to the normal Tab order. */}
          <main id={MAIN_CONTENT_ID} tabIndex={-1} style={contentStyle}>
            {children}
          </main>
        </div>
        <Footer />
      </div>
    </div>
  );
}

// First focusable element in the app (DOM order, before TopBar's own
// controls), visually hidden until it receives keyboard focus.
function SkipLink({ colors }: { colors: ColorPalette }) {
  const [isFocused, setIsFocused] = useState(false);
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
      style={skipLinkStyle(colors, isFocused)}
    >
      Skip to content
    </a>
  );
}

function pageStyle(colors: ColorPalette): CSSProperties {
  return {
    width: '100vw',
    height: '100vh',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: colors.pageRadial,
  };
}
// position: relative so SkipLink's absolute positioning (and the frame's own
// overflow: hidden) both scope to this 1536x1024 canvas, not the viewport.
const frameStyle: CSSProperties = {
  width: 1536,
  height: 1024,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  flexShrink: 0,
  position: 'relative',
};
const contentStyle: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 };
function skipLinkStyle(colors: ColorPalette, focused: boolean): CSSProperties {
  return {
    position: 'absolute',
    // Off the top edge (clipped by the frame's overflow: hidden) until
    // focused, then dropped into view above the top bar.
    top: focused ? 8 : -60,
    left: 8,
    zIndex: 200,
    padding: '8px 14px',
    borderRadius: 8,
    background: colors.panelInset,
    border: `1px solid ${colors.accentCyan}`,
    color: colors.textPrimary,
    font: `600 12px/1 ${fonts.ui}`,
    textDecoration: 'none',
  };
}
