import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { AgentRosterCard } from './AgentRosterCard';
import type { RealAgentDispatch } from '../../state/liveAgentsMath';

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

function CompletionSetter({ toolUseId, narration }: { toolUseId: string; narration: string }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    const dispatchInfo: RealAgentDispatch = {
      toolUseId,
      subagentType: 'FORGE-role-agent',
      description: 'building',
      startedAt: new Date().toISOString(),
      prompt: '',
      model: null,
    };
    // Drive the real pipeline: an open dispatch that later disappears from
    // the live snapshot is what actually moves it into
    // state.recentCompletedDispatches (see reducer's SET_REAL_AGENTS case /
    // detectCompletedDispatches) -- this is the only way a completed
    // dispatch and its narration can coexist in production, per main.ts's
    // agents:narration emission timing.
    dispatch({ type: 'SET_REAL_AGENTS', agents: [dispatchInfo] });
    dispatch({ type: 'SET_REAL_AGENTS', agents: [] });
    dispatch({ type: 'SET_DISPATCH_NARRATION', toolUseId, narration });
  }, [dispatch, toolUseId, narration]);
  return null;
}

describe('AgentRosterCard DONE group narration', () => {
  it('renders a narration for a completed dispatch under the DONE group', () => {
    render(
      <AetherStoreProvider>
        <CompletionSetter toolUseId="tu-done-1" narration="Done. Four files touched." />
        <AgentRosterCard selectedToolUseId={null} />
      </AetherStoreProvider>,
    );
    expect(screen.getByText('DONE')).toBeTruthy();
    expect(screen.getByText('Done. Four files touched.')).toBeTruthy();
  });
});
