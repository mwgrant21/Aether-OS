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

    const silentButton = screen.getByText('SILENT');
    const fullButton = screen.getByText('FULL');
    expect(silentButton.style.background).toContain('linear-gradient');
    expect(silentButton.style.boxShadow).toContain('rgba(95,220,255');
    expect(fullButton.style.background).not.toContain('linear-gradient');
    expect(fullButton.style.boxShadow).toBe('');
  });
});
