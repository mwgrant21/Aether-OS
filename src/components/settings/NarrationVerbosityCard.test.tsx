import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { NarrationVerbosityCard } from './NarrationVerbosityCard';
import { AetherStoreProvider } from '../../state/store';

afterEach(cleanup);

describe('NarrationVerbosityCard', () => {
  it('shows FULL as active by default', () => {
    render(
      <AetherStoreProvider>
        <NarrationVerbosityCard />
      </AetherStoreProvider>,
    );
    expect(screen.getByText('FULL')).toBeTruthy();
  });

  it('clicking SILENT updates cfg.narrationVerbosity', () => {
    render(
      <AetherStoreProvider>
        <NarrationVerbosityCard />
      </AetherStoreProvider>,
    );
    fireEvent.click(screen.getByText('SILENT'));
    expect(screen.getByText(/severity 3\+/i)).toBeTruthy();
  });
});
