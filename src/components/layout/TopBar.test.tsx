import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TopBar } from './TopBar';
import { AetherStoreProvider } from '../../state/store';
import { colors } from '../../styles/tokens';
import { NOTIF_TRIGGER_ATTR } from './useDropdownFocus';

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

describe('TopBar notifications focus', () => {
  const bell = () => screen.getByRole('button', { name: /^Notifications/ });
  const appr = () => screen.getByRole('button', { name: /pending approval/ });
  const panel = () => document.getElementById(bell().getAttribute('aria-controls')!)!;
  function openFromBell() {
    bell().focus();
    fireEvent.click(bell());
  }

  it('marks the bell as a notifications trigger', () => {
    renderTopBar();
    expect(bell().closest(`[${NOTIF_TRIGGER_ATTR}]`)).not.toBeNull();
  });

  it('moves focus into the panel on open, and back to the bell on Escape', () => {
    renderTopBar();
    openFromBell();
    expect(panel().getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(panel());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(bell());
  });

  it('closes on a pointer-down outside the panel and its trigger, not on one inside the panel', () => {
    renderTopBar();
    openFromBell();
    fireEvent.pointerDown(panel());
    expect(bell().getAttribute('aria-expanded')).toBe('true');
    fireEvent.pointerDown(document.body);
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(bell());
  });

  it('closes, not close-then-reopens, when the bell is pressed while open', () => {
    renderTopBar();
    openFromBell();
    fireEvent.pointerDown(bell());
    fireEvent.click(bell());
    expect(bell().getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps approvals and notifications exclusive under real pointer input', () => {
    renderTopBar();
    openFromBell();
    fireEvent.pointerDown(appr());
    appr().focus();
    fireEvent.click(appr());
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    expect(appr().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(appr());
  });

  it('does not pull focus off the approvals button when opening approvals closes notifications', () => {
    renderTopBar();
    openFromBell();
    appr().focus(); // keyboard: Tab to approvals, then Enter
    fireEvent.click(appr());
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(appr());
  });
});
