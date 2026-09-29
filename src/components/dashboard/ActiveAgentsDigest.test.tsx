import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AetherStoreProvider } from '../../state/store';
import { ActiveAgentsDigest } from './ActiveAgentsDigest';

afterEach(cleanup);

describe('ActiveAgentsDigest empty state', () => {
  it('says what will appear, with no action of its own (the Reactor card owns OPEN TERMINAL)', () => {
    render(
      <AetherStoreProvider>
        <ActiveAgentsDigest />
      </AetherStoreProvider>,
    );
    expect(screen.getByText('Agents dispatched from the Terminal will appear here.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
