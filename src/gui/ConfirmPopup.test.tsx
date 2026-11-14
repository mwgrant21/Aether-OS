import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmPopup } from './ConfirmPopup';

afterEach(cleanup);

describe('ConfirmPopup', () => {
  it('is a dialog with the message, and Cancel holds the focus', () => {
    render(<ConfirmPopup message="Sure?" confirmLabel="Do it" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Sure?')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByText('Cancel'));
  });
  it('confirmOnEnter focuses the confirm button instead of Cancel', () => {
    render(<ConfirmPopup message="Sure?" confirmLabel="Do it" confirmOnEnter onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByText('Do it'));
    expect(document.activeElement).not.toBe(screen.getByText('Cancel'));
  });
  it('with confirmOnEnter Esc still cancels', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmPopup message="Sure?" confirmLabel="Do it" confirmOnEnter onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
  it('with confirmOnEnter a repeated Enter is default-prevented and a single Enter is not', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmPopup message="Sure?" confirmLabel="Do it" confirmOnEnter onConfirm={onConfirm} onCancel={onCancel} />);
    const confirm = screen.getByText('Do it');
    expect(fireEvent.keyDown(confirm, { key: 'Enter', repeat: true })).toBe(false);
    expect(fireEvent.keyDown(confirm, { key: 'Enter' })).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
  it('the confirm label confirms, Cancel and Esc cancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmPopup message="Sure?" confirmLabel="Do it" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Do it'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
