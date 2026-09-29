import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AetherStoreProvider } from '../../state/store';
import { AgentDetailCard } from './AgentDetailCard';

afterEach(cleanup);

describe('AgentDetailCard empty state', () => {
  it('uses the shared EmptyState with one detail-specific sentence when no agent is running', () => {
    const { container } = render(
      <AetherStoreProvider>
        <AgentDetailCard agent={null} />
      </AetherStoreProvider>,
    );
    const empty = container.querySelector('[data-empty-state]');
    expect(empty?.textContent).toBe("A running agent's prompt and elapsed time will appear here.");
    expect(container.textContent).not.toContain('No agent dispatches are currently running.');
  });
});
