import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GuiComposer } from './GuiComposer';

const box = () => screen.getByLabelText('Message') as HTMLTextAreaElement;
const type = (v: string) => fireEvent.change(box(), { target: { value: v } });

afterEach(cleanup);

describe('GuiComposer', () => {
  it('Enter submits and clears when onSubmit resolves true', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<GuiComposer disabled={false} onSubmit={onSubmit} />);
    type('hello');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('hello');
    await waitFor(() => expect(box().value).toBe(''));
  });

  it('keeps the text when onSubmit returns false', async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    render(<GuiComposer disabled={false} onSubmit={onSubmit} />);
    type('keep me');
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    await Promise.resolve();
    expect(box().value).toBe('keep me');
  });

  it('Shift+Enter does not submit', () => {
    const onSubmit = vi.fn();
    render(<GuiComposer disabled={false} onSubmit={onSubmit} />);
    type('a');
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Enter during IME composition is ignored', () => {
    const onSubmit = vi.fn();
    render(<GuiComposer disabled={false} onSubmit={onSubmit} />);
    type('a');
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not submit empty or whitespace-only text', () => {
    const onSubmit = vi.fn();
    render(<GuiComposer disabled={false} onSubmit={onSubmit} />);
    type('  \n ');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disabled blocks submit and shows the placeholder', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<GuiComposer disabled={false} placeholder="Starting Claude..." onSubmit={onSubmit} />);
    type('typed first');
    rerender(<GuiComposer disabled placeholder="Starting Claude..." onSubmit={onSubmit} />);
    expect(box().placeholder).toBe('Starting Claude...');
    expect(box().disabled).toBe(true);
    fireEvent.keyDown(box(), { key: 'Enter' });
    fireEvent.click(screen.getByLabelText('Send'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('a second Enter while a submit is in flight is ignored', () => {
    const onSubmit = vi.fn(() => new Promise<boolean>(() => {}));
    render(<GuiComposer disabled={false} onSubmit={onSubmit} />);
    type('once');
    fireEvent.keyDown(box(), { key: 'Enter' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('keeps the text when onSubmit rejects or throws', async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error('x')).mockImplementationOnce(() => {
      throw new Error('y');
    });
    render(<GuiComposer disabled={false} onSubmit={onSubmit} />);
    type('keep');
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(box().value).toBe('keep');
  });

  it('does not clear text edited while the submit was in flight', async () => {
    let resolve!: (v: boolean) => void;
    const onSubmit = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    render(<GuiComposer disabled={false} onSubmit={onSubmit} />);
    type('first');
    fireEvent.keyDown(box(), { key: 'Enter' });
    type('first and more');
    resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(box().value).toBe('first and more');
  });

  it('Send button submits', () => {
    const onSubmit = vi.fn().mockReturnValue(true);
    render(<GuiComposer disabled={false} onSubmit={onSubmit} />);
    type('via button');
    fireEvent.click(screen.getByLabelText('Send'));
    expect(onSubmit).toHaveBeenCalledWith('via button');
  });

  it('renders the leading slot', () => {
    render(<GuiComposer disabled={false} onSubmit={vi.fn()} leading={<span>lead-slot</span>} />);
    expect(screen.getByText('lead-slot')).toBeTruthy();
  });
});
