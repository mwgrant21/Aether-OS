import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModePicker } from './ModePicker';

afterEach(cleanup);

describe('ModePicker', () => {
  it('shows the current mode and lists the four modes when opened', () => {
    render(<ModePicker mode="auto" disabled={false} onSelect={vi.fn()} />);
    expect(screen.getByLabelText('Permission mode: Auto').textContent).toBe('● Auto ▾');
    fireEvent.click(screen.getByLabelText('Permission mode: Auto'));
    expect(screen.getAllByRole('menuitem').map((e) => e.textContent)).toEqual(['● Manual', '● Accept edits', '● Plan', '● Auto']);
  });
  it('selecting an item calls onSelect and closes the list', () => {
    const onSelect = vi.fn();
    render(<ModePicker mode="auto" disabled={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByLabelText('Permission mode: Auto'));
    fireEvent.click(screen.getByText('● Plan'));
    expect(onSelect).toHaveBeenCalledWith('plan');
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('Esc and an outside click close the list', () => {
    render(<ModePicker mode="plan" disabled={false} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Permission mode: Plan'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByLabelText('Permission mode: Plan'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('disabled opens no list, carries the hint as title and aria-disabled', () => {
    render(<ModePicker mode="auto" disabled hint="Wait for the reply to finish" onSelect={vi.fn()} />);
    const b = screen.getByLabelText('Permission mode: Auto');
    fireEvent.click(b);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(b.getAttribute('title')).toBe('Wait for the reply to finish');
    expect(b.getAttribute('aria-disabled')).toBe('true');
  });
});
