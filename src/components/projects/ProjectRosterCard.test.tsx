import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ProjectRosterCard } from './ProjectRosterCard';
import { AetherStoreProvider } from '../../state/store';

afterEach(cleanup);

describe('ProjectRosterCard keyboard access', () => {
  it('the ADD control is a real keyboard-native button', () => {
    const { getByRole } = render(
      <AetherStoreProvider>
        <ProjectRosterCard selectedName={null} />
      </AetherStoreProvider>,
    );
    const addButton = getByRole('button', { name: /ADD/i });
    expect(addButton.tagName).toBe('BUTTON');
  });
});
