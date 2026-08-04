import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { AgentRosterCard } from './AgentRosterCard';
import type { RealAgentDispatch } from '../../state/types';

afterEach(cleanup);

function Setter({ agents, narrations }: { agents: RealAgentDispatch[]; narrations: Record<string, string> }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    dispatch({ type: 'SET_REAL_AGENTS', agents });
    for (const [toolUseId, narration] of Object.entries(narrations)) {
      dispatch({ type: 'SET_DISPATCH_NARRATION', toolUseId, narration });
    }
  }, [dispatch, agents, narrations]);
  return null;
}

function renderWithState(agents: RealAgentDispatch[], narrations: Record<string, string>) {
  return render(
    <AetherStoreProvider>
      <Setter agents={agents} narrations={narrations} />
      <AgentRosterCard selectedToolUseId={null} />
    </AetherStoreProvider>,
  );
}

describe('AgentRosterCard narration', () => {
  it('renders the narration line under a dispatch when present', () => {
    renderWithState(
      [{ toolUseId: 'tu-1', subagentType: 'CINDER-role-agent', description: 'reviewing', startedAt: new Date().toISOString(), prompt: '', model: null }],
      { 'tu-1': 'Done. Four files touched.' },
    );
    expect(screen.getByText('Done. Four files touched.')).toBeTruthy();
  });

  it('renders nothing extra when no narration exists for a dispatch', () => {
    renderWithState(
      [{ toolUseId: 'tu-2', subagentType: 'general-purpose', description: 'working', startedAt: new Date().toISOString(), prompt: '', model: null }],
      {},
    );
    expect(screen.queryByTestId('narration-line')).toBeFalsy();
  });
});
