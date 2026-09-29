import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AetherStoreProvider } from '../../state/store';
import { ActiveAgentsDigest } from './ActiveAgentsDigest';

afterEach(cleanup);

describe('ActiveAgentsDigest empty state', () => {
  it('uses the same no-agents sentence as the Agents and Terminal views, with no action of its own', () => {
    render(
      <AetherStoreProvider>
        <ActiveAgentsDigest />
      </AetherStoreProvider>,
    );
    expect(screen.getByText('No agents are running.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
