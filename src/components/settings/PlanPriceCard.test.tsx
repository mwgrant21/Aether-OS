import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { PlanPriceCard } from './PlanPriceCard';
import { AetherStoreProvider } from '../../state/store';

afterEach(cleanup);

function renderCard() {
  return render(
    <AetherStoreProvider>
      <PlanPriceCard />
    </AetherStoreProvider>,
  );
}

describe('PlanPriceCard', () => {
  it('starts with no price set and says what that costs the operator', () => {
    renderCard();
    // No @testing-library/jest-dom in this project (not a dependency, and no
    // other test file uses its matchers) -- toHaveValue is not registered,
    // so this asserts the native input value directly instead.
    expect((screen.getByLabelText('Monthly plan price in USD') as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/quota points only/i)).toBeTruthy();
  });

  it('stores a typed price on the config', () => {
    renderCard();
    const input = screen.getByLabelText('Monthly plan price in USD');
    fireEvent.change(input, { target: { value: '200' } });
    expect(screen.getByText('$0.50')).toBeTruthy(); // $200 / 400 points
  });

  it('clears back to null on an empty field rather than storing 0', () => {
    renderCard();
    const input = screen.getByLabelText('Monthly plan price in USD');
    fireEvent.change(input, { target: { value: '200' } });
    fireEvent.change(input, { target: { value: '' } });
    // 0 would render "$0.00 per point", which reads as a free plan. Null
    // reads as "not configured", which is the truth.
    expect(screen.getByText(/quota points only/i)).toBeTruthy();
  });

  it('rejects a negative price rather than storing a negative rate', () => {
    renderCard();
    fireEvent.change(screen.getByLabelText('Monthly plan price in USD'), { target: { value: '-50' } });
    expect(screen.getByText(/quota points only/i)).toBeTruthy();
  });

  it('stores a deliberately entered 0 as a real zero price, distinct from unset', () => {
    renderCard();
    const input = screen.getByLabelText('Monthly plan price in USD');
    fireEvent.change(input, { target: { value: '0' } });
    // A typed 0 must survive as 0, not collapse to the unset sentinel: the
    // input keeps showing 0 (not blank)...
    expect((input as HTMLInputElement).value).toBe('0');
    // ...the per-point figure prices it as an actual $0.00 rate rather than
    // showing the unconfigured dash...
    expect(screen.getByText('$0.00')).toBeTruthy();
    // ...and the "not configured" copy must NOT be showing, because this
    // plan price *is* configured -- it's just zero.
    expect(screen.queryByText(/quota points only/i)).toBeNull();
  });
});
