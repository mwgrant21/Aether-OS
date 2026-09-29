import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TopBar } from './TopBar';
import { AetherStoreProvider } from '../../state/store';
import { colors } from '../../styles/tokens';

afterEach(cleanup);

// jsdom normalizes colours (hex -> rgb), so compare through the same parser.
function cssColor(value: string): string {
  const el = document.createElement('span');
  el.style.color = value;
  return el.style.color;
}

function renderTopBar() {
  return render(
    <AetherStoreProvider>
      <TopBar />
    </AetherStoreProvider>,
  );
}

describe('TopBar operating-mode pills', () => {
  it('expose the selected mode through aria-pressed, exactly one at a time', () => {
    renderTopBar();
    const group = screen.getByRole('group', { name: 'Operating mode' });
    const pills = within(group).getAllByRole('button');
    expect(pills.map((p) => p.textContent?.trim().split(/\s+/).pop())).toEqual(['PLAN', 'EDITS', 'AUTO']);
    expect(pills.filter((p) => p.getAttribute('aria-pressed') === 'true')).toHaveLength(1);

    fireEvent.click(within(group).getByRole('button', { name: 'AUTO' }));
    expect(within(group).getByRole('button', { name: 'AUTO' }).getAttribute('aria-pressed')).toBe('true');
    expect(pills.filter((p) => p.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
  });

  it('renders the AUTO bolt in text presentation so it inherits the pill colour', () => {
    renderTopBar();
    const auto = screen.getByRole('button', { name: 'AUTO' });
    expect(auto.textContent).toContain('⚡︎');
  });
});

describe('TopBar dropdowns', () => {
  it('are mutually exclusive: opening Notifications closes Approvals and vice versa', () => {
    renderTopBar();
    const appr = screen.getByRole('button', { name: /pending approval/ });
    const notif = screen.getByRole('button', { name: /^Notifications/ });
    fireEvent.click(appr);
    expect(screen.getByText(/APPROVAL QUEUE/)).toBeTruthy();
    fireEvent.click(notif);
    expect(screen.queryByText(/APPROVAL QUEUE/)).toBeNull();
    expect(screen.getByText('NOTIFICATIONS')).toBeTruthy();
    fireEvent.click(appr);
    expect(screen.queryByText('NOTIFICATIONS')).toBeNull();
    expect(screen.getByText(/APPROVAL QUEUE/)).toBeTruthy();
  });

  it('expose open state through aria-expanded and point aria-controls at the open panel', () => {
    renderTopBar();
    const appr = screen.getByRole('button', { name: /pending approval/ });
    const notif = screen.getByRole('button', { name: /^Notifications/ });
    expect(appr.getAttribute('aria-expanded')).toBe('false');
    expect(notif.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(appr);
    expect(appr.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(appr.getAttribute('aria-controls')!)?.textContent).toMatch(/APPROVAL QUEUE/);
    fireEvent.click(notif);
    expect(notif.getAttribute('aria-expanded')).toBe('true');
    expect(appr.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(notif.getAttribute('aria-controls')!)?.textContent).toMatch(/NOTIFICATIONS/);
  });

  it('never mixes border and borderColor on the approvals button, so hovering it raises no React style warning', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderTopBar();
    const appr = screen.getByRole('button', { name: /pending approval/ });
    fireEvent.mouseEnter(appr);
    fireEvent.mouseLeave(appr);
    const conflicts = err.mock.calls.filter((c) => String(c[0]).includes('conflicting property'));
    err.mockRestore();
    expect(conflicts).toHaveLength(0);
  });
});

describe('TopBar notifications dropdown', () => {
  it('paints alert rows from tone tokens, not the stored notif colour', () => {
    renderTopBar();
    fireEvent.click(screen.getByRole('button', { name: 'AUTO' })); // pushes "Operating mode set to AUTO", c: '#7fd8ef'
    fireEvent.click(screen.getByRole('button', { name: /^Notifications/ }));
    // getAll: earlier tests in this file also switch to AUTO.
    expect(screen.getAllByText('Operating mode set to AUTO')[0].style.color).toBe(cssColor(colors.textSecondary));
  });
});
