import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { OperatorCard } from './OperatorCard';
import { AetherStoreProvider } from '../../state/store';
import { colors } from '../../styles/tokens';

afterEach(cleanup);

// jsdom's CSSOM re-serializes color functions (rgba spacing/precision) on
// readback, so assert against its own round-trip rather than a literal string.
function normalizeBorder(color: string): string {
  const el = document.createElement('div');
  el.style.border = `1px solid ${color}`;
  return el.style.borderColor;
}

function renderCard() {
  return render(
    <AetherStoreProvider>
      <OperatorCard />
    </AetherStoreProvider>,
  );
}

describe('OperatorCard focus treatment', () => {
  it('shows the cyan border and translucent ring when the name input is focused', () => {
    const { getByPlaceholderText } = renderCard();
    const input = getByPlaceholderText('Operator');
    expect(input.style.border).toBe(`1px solid ${normalizeBorder(colors.chipBorder)}`);
    fireEvent.focus(input);
    expect(input.style.border).toBe(`1px solid ${normalizeBorder(colors.accentCyan)}`);
    expect(input.style.boxShadow).not.toBe('');
  });

  it('reverts the border/ring on blur', () => {
    const { getByPlaceholderText } = renderCard();
    const input = getByPlaceholderText('Operator');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(input.style.border).toBe(`1px solid ${normalizeBorder(colors.chipBorder)}`);
    expect(input.style.boxShadow).toBe('');
  });
});
