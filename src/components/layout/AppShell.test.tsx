import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppShell, MAIN_CONTENT_ID } from './AppShell';
import { AetherStoreProvider } from '../../state/store';

// AppShell renders Sidebar -> Reactor, which calls useReducedMotion() ->
// window.matchMedia. jsdom doesn't implement it (same stub as Sidebar.test.tsx).
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderShell() {
  return render(
    <AetherStoreProvider>
      <AppShell>
        <div>content</div>
      </AppShell>
    </AetherStoreProvider>,
  );
}

describe('AppShell landmarks', () => {
  it('renders exactly one header, one nav, one main, and one footer landmark', () => {
    renderShell();
    expect(document.querySelectorAll('header')).toHaveLength(1);
    expect(document.querySelectorAll('nav')).toHaveLength(1);
    expect(document.querySelectorAll('main')).toHaveLength(1);
    expect(document.querySelectorAll('footer')).toHaveLength(1);
  });

  it('gives the sidebar nav an accessible name', () => {
    renderShell();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
  });

  it('renders the skip link as the first focusable element, pointing at the main landmark', () => {
    renderShell();
    const link = screen.getByText('Skip to content');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(`#${MAIN_CONTENT_ID}`);
    const main = document.querySelector('main')!;
    expect(main.id).toBe(MAIN_CONTENT_ID);
  });

  it('hides the skip link until it receives focus, then reveals it', () => {
    renderShell();
    const link = screen.getByText('Skip to content');
    expect(Number(link.style.top.replace('px', ''))).toBeLessThan(0);
    fireEvent.focus(link);
    expect(link.style.top).toBe('8px');
    fireEvent.blur(link);
    expect(Number(link.style.top.replace('px', ''))).toBeLessThan(0);
  });
});
