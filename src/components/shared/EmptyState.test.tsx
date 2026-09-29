import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EmptyState, FOCUS_RING_CLEARANCE } from './EmptyState';

afterEach(cleanup);

describe('EmptyState', () => {
  it('reserves room for the 5px keyboard focus ring around an action so an overflow container never clips it', () => {
    const { container } = render(<EmptyState message="Nothing here yet." action={{ label: 'OPEN TERMINAL', onClick: () => {} }} />);
    // DESIGN.md focus ring: 2px outline + 3px offset = 5px beyond the action.
    expect(FOCUS_RING_CLEARANCE).toBeGreaterThanOrEqual(5);
    const root = container.querySelector<HTMLElement>('[data-empty-state]')!;
    expect(root.style.padding).toBe(`${FOCUS_RING_CLEARANCE}px`);
  });

  it('adds no indent to a message-only empty state, so its sentence aligns with the panel heading', () => {
    const { container } = render(<EmptyState message="No alerts right now." />);
    const root = container.querySelector<HTMLElement>('[data-empty-state]')!;
    expect(root.style.padding).toBe('');
    expect(root.style.margin).toBe('');
  });

  it('renders one sentence and at most one action that fires its handler', () => {
    const onClick = vi.fn();
    render(<EmptyState message="No agents are running." action={{ label: 'OPEN TERMINAL', onClick }} />);
    expect(screen.getByText('No agents are running.')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'OPEN TERMINAL' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('takes a ready-made action in actionSlot and reserves the same focus-ring room for it', () => {
    const { container } = render(<EmptyState message="No agents are running." actionSlot={<button type="button">GO</button>} />);
    const root = container.querySelector<HTMLElement>('[data-empty-state]')!;
    expect(root.style.padding).toBe(`${FOCUS_RING_CLEARANCE}px`);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'GO' })).toBeTruthy();
  });
});
