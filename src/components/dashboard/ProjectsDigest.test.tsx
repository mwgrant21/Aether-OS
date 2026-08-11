import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { ProjectsDigest } from './ProjectsDigest';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';

afterEach(cleanup);

function Setter({ snapshot }: { snapshot: ProjectsSnapshot | null }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    dispatch({ type: 'SET_PROJECTS_SNAPSHOT', snapshot });
  }, [dispatch, snapshot]);
  return null;
}

function TabProbe() {
  const { state } = useAetherStore();
  return <div data-testid="active-tab">{state.activeTab}</div>;
}

function renderWithSnapshot(snapshot: ProjectsSnapshot | null) {
  return render(
    <AetherStoreProvider>
      <Setter snapshot={snapshot} />
      <ProjectsDigest />
      <TabProbe />
    </AetherStoreProvider>,
  );
}

const EMPTY_LEDGER = {
  total: { usd: 1.23 },
} as ProjectsSnapshot['roots'][number]['ledger'];

const EMPTY_OPTIMIZE = {
  findings: [],
  summary: { totalPerWeek: 0, grade: 'A' as const },
  breakdown: [],
};

const SNAPSHOT: ProjectsSnapshot = {
  roots: [
    { key: 'r1', name: 'aether-os', worktree: null, ledger: EMPTY_LEDGER, optimize: EMPTY_OPTIMIZE, children: [] },
  ],
  unscoped: null,
  computedAtMs: Date.now(),
};

describe('ProjectsDigest', () => {
  it('clicking the VIEW ALL affordance dispatches SET_ACTIVE_TAB to Projects', () => {
    renderWithSnapshot(SNAPSHOT);
    fireEvent.click(screen.getByText(/view all/i));
    expect(screen.getByTestId('active-tab').textContent).toBe('Projects');
  });

  it('renders the VIEW ALL affordance even in the empty state', () => {
    renderWithSnapshot(null);
    expect(screen.getByText(/view all/i)).toBeTruthy();
  });
});
