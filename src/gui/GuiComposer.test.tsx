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
    render(<GuiComposer disabled placeholder="Starting Claude..." onSubmit={onSubmit} />);
    expect(box().placeholder).toBe('Starting Claude...');
    expect(box().disabled).toBe(true);
    fireEvent.keyDown(box(), { key: 'Enter' });
    fireEvent.click(screen.getByLabelText('Send'));
    expect(onSubmit).not.toHaveBeenCalled();
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
