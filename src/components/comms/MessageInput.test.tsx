import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { MessageInput } from './MessageInput';
import { colors } from '../../styles/tokens';

afterEach(cleanup);

// jsdom's CSSOM re-serializes color functions (rgba spacing/precision) on
// readback, so assert against its own round-trip rather than a literal string.
function normalizeBorder(color: string): string {
  const el = document.createElement('div');
  el.style.border = `1px solid ${color}`;
  return el.style.borderColor;
}

describe('MessageInput focus treatment', () => {
  it('shows the cyan border and translucent ring on the wrapping row when the input is focused', () => {
    const { getByPlaceholderText } = render(
      <MessageInput value="" onChange={vi.fn()} onSubmit={vi.fn()} placeholder="Filter" />,
    );
    const input = getByPlaceholderText('Filter');
    const row = input.parentElement as HTMLElement;
    // jsdom's CSSOM normalizes rgba() spacing/precision on readback, so assert
    // against the browser's own re-serialization rather than our literal string.
    const chipBorderNormalized = normalizeBorder(colors.chipBorder);
    const accentCyanNormalized = normalizeBorder(colors.accentCyan);
    expect(row.style.border).toBe(`1px solid ${chipBorderNormalized}`);
    fireEvent.focus(input);
    expect(row.style.border).toBe(`1px solid ${accentCyanNormalized}`);
    expect(row.style.boxShadow).not.toBe('');
  });

  it('reverts the row border/ring on blur', () => {
    const { getByPlaceholderText } = render(
      <MessageInput value="" onChange={vi.fn()} onSubmit={vi.fn()} placeholder="Filter" />,
    );
    const input = getByPlaceholderText('Filter');
    const row = input.parentElement as HTMLElement;
    const chipBorderNormalized = normalizeBorder(colors.chipBorder);
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(row.style.border).toBe(`1px solid ${chipBorderNormalized}`);
    expect(row.style.boxShadow).toBe('');
  });
});
