import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRosterCard } from './MemoryRosterCard';
import { AetherStoreProvider } from '../../state/store';

afterEach(cleanup);

describe('MemoryRosterCard keyboard access', () => {
  it('the remember-submit control is a real keyboard-native button', () => {
    const { getByRole } = render(
      <AetherStoreProvider>
        <MemoryRosterCard selectedId={null} />
      </AetherStoreProvider>,
    );
    const submitButton = getByRole('button', { name: '+' });
    expect(submitButton.tagName).toBe('BUTTON');
  });
});
