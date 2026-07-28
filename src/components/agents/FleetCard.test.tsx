import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { FleetCard } from './FleetCard';
import type { FleetSessionRow } from '../../state/types';

afterEach(cleanup);

function Setter({ fleet }: { fleet: FleetSessionRow[] | null }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    dispatch({ type: 'SET_FLEET', fleet });
  }, [dispatch, fleet]);
  return null;
}

function renderWithFleet(fleet: FleetSessionRow[] | null) {
  return render(
    <AetherStoreProvider>
      <Setter fleet={fleet} />
      <FleetCard />
    </AetherStoreProvider>,
  );
}

const ROW: FleetSessionRow = {
  sessionId: 's1',
  pid: 100,
  projectName: 'my-project',
  kind: 'interactive',
  status: 'busy',
  name: 'it-68',
  startedAtMs: Date.now() - 60000,
};

describe('FleetCard', () => {
  it('shows the unavailable state when fleet is null (collector not running)', () => {
    renderWithFleet(null);
    expect(screen.getByText(/collector/i)).toBeTruthy();
  });

  it('shows the empty state when fleet is an empty array', () => {
    renderWithFleet([]);
    expect(screen.getByText(/no other sessions detected/i)).toBeTruthy();
  });

  it('renders a row for each fleet session, showing project name, session name, and status', () => {
    renderWithFleet([ROW]);
    expect(screen.getByText('my-project')).toBeTruthy();
    expect(screen.getByText('it-68')).toBeTruthy();
    expect(screen.getByText(/busy/i)).toBeTruthy();
  });

  it('expands a row in place on click, without any new data fetch', () => {
    renderWithFleet([ROW]);
    fireEvent.click(screen.getByText('my-project'));
    expect(screen.getByText(/interactive/i)).toBeTruthy();
  });

  it('renders rows sorted by startedAtMs ascending regardless of input order', () => {
    const older: FleetSessionRow = {
      sessionId: 's2',
      pid: 200,
      projectName: 'older-project',
      kind: 'interactive',
      status: 'idle',
      name: 'it-1',
      startedAtMs: Date.now() - 120000,
    };
    const newer: FleetSessionRow = {
      sessionId: 's3',
      pid: 300,
      projectName: 'newer-project',
      kind: 'interactive',
      status: 'idle',
      name: 'it-2',
      startedAtMs: Date.now() - 10000,
    };
    // Pass in reverse order (newer before older) — rendering should still
    // put the older (longer-running) session first.
    renderWithFleet([newer, older]);
    const names = screen.getAllByText(/-project$/).map((el) => el.textContent);
    expect(names).toEqual(['older-project', 'newer-project']);
  });
});
