import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { CrossEngineVerificationCard } from './CrossEngineVerificationCard';
import { AetherStoreProvider } from '../../state/store';

afterEach(cleanup);

describe('CrossEngineVerificationCard', () => {
  it('defaults to disabled', () => {
    render(
      <AetherStoreProvider>
        <CrossEngineVerificationCard />
      </AetherStoreProvider>,
    );
    expect(screen.getByText('ENABLE')).toBeTruthy();
    expect(screen.queryByText('SUBSCRIPTION ONLY')).toBeNull();
  });

  it('requires explicit confirmation before first enablement', () => {
    render(
      <AetherStoreProvider>
        <CrossEngineVerificationCard />
      </AetherStoreProvider>,
    );

    fireEvent.click(screen.getByText('ENABLE'));

    // Disclosure shown, but not yet enabled.
    expect(screen.getByText('I UNDERSTAND, ENABLE')).toBeTruthy();
    expect(screen.queryByText('SUBSCRIPTION ONLY')).toBeNull();
    expect(screen.getByText('ENABLE')).toBeTruthy();

    fireEvent.click(screen.getByText('I UNDERSTAND, ENABLE'));

    expect(screen.getByText('SUBSCRIPTION ONLY')).toBeTruthy();
    expect(screen.getByText('DISABLE')).toBeTruthy();
  });

  it('shows SUBSCRIPTION ONLY billing label when enabled', () => {
    render(
      <AetherStoreProvider>
        <CrossEngineVerificationCard />
      </AetherStoreProvider>,
    );

    fireEvent.click(screen.getByText('ENABLE'));
    fireEvent.click(screen.getByText('I UNDERSTAND, ENABLE'));

    expect(screen.getByText('SUBSCRIPTION ONLY')).toBeTruthy();
  });

  it('never renders an API key input field anywhere', () => {
    render(
      <AetherStoreProvider>
        <CrossEngineVerificationCard />
      </AetherStoreProvider>,
    );

    fireEvent.click(screen.getByText('ENABLE'));
    fireEvent.click(screen.getByText('I UNDERSTAND, ENABLE'));

    expect(screen.queryByLabelText(/api key/i)).toBeNull();
    expect(document.querySelector('input')).toBeNull();
  });
});
