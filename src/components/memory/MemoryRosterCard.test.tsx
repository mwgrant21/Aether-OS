import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRosterCard } from './MemoryRosterCard';
import { AetherStoreProvider } from '../../state/store';

afterEach(cleanup);

describe('MemoryRosterCard keyboard access', () => {
  it('the scope-filter and tombstone-toggle controls are real keyboard-native buttons', () => {
    const { getByRole } = render(
      <AetherStoreProvider>
        <MemoryRosterCard selectedId={null} />
      </AetherStoreProvider>,
    );
    const allButton = getByRole('button', { name: 'All' });
    expect(allButton.tagName).toBe('BUTTON');
    const sharedButton = getByRole('button', { name: 'Shared' });
    expect(sharedButton.tagName).toBe('BUTTON');
    const tombstoneButton = getByRole('button', { name: /Tombstones/ });
    expect(tombstoneButton.tagName).toBe('BUTTON');
  });
});
