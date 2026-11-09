import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AetherStoreProvider } from '../../state/store';
import { ActiveAgentsCard } from './ActiveAgentsCard';

afterEach(cleanup);

describe('ActiveAgentsCard sizing', () => {
  it('can shrink inside the rail and scrolls its own list, so many agents never push the other cards down', () => {
    const { container } = render(
      <AetherStoreProvider>
        <ActiveAgentsCard />
      </AetherStoreProvider>,
    );
    const card = container.firstElementChild as HTMLElement;
    // jsdom has no layout; this pins the two declarations that make the flex item shrinkable.
    expect(card.style.minHeight).toBe('0');
    expect(card.style.overflow).toBe('hidden');
    const list = card.lastElementChild as HTMLElement;
    expect(list.style.overflow).toBe('auto');
    expect(list.style.minHeight).toBe('0');
  });
});
