import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { OrchestrationGrid } from './OrchestrationGrid';
import type { RealActiveWork } from '../../state/liveAgentsMath';

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      constructor(_callback: any) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
  }
});

afterEach(cleanup);

function agent(toolUseId: string, label: string): RealActiveWork {
  return { toolUseId, kind: 'agent', label, description: 'Explore the docs directory', startedAt: new Date().toISOString() };
}

describe('OrchestrationGrid keyboard access', () => {
  it('calls onSelectRealAgent when Enter is pressed on a focused node', () => {
    const onSelectRealAgent = vi.fn();
    const { getByRole } = render(
      <OrchestrationGrid agents={[agent('tu_1', 'Explore')]} rate={90000} anomalies={[]} onSelectRealAgent={onSelectRealAgent} />,
    );
    const node = getByRole('button', { name: /Explore/i });
    fireEvent.keyDown(node, { key: 'Enter' });
    expect(onSelectRealAgent).toHaveBeenCalledWith('tu_1');
  });

  it('calls onSelectRealAgent when Space is pressed on a focused node', () => {
    const onSelectRealAgent = vi.fn();
    const { getByRole } = render(
      <OrchestrationGrid agents={[agent('tu_1', 'Explore')]} rate={90000} anomalies={[]} onSelectRealAgent={onSelectRealAgent} />,
    );
    const node = getByRole('button', { name: /Explore/i });
    fireEvent.keyDown(node, { key: ' ' });
    expect(onSelectRealAgent).toHaveBeenCalledWith('tu_1');
  });

  it('the node is focusable via tabIndex', () => {
    const { getByRole } = render(
      <OrchestrationGrid agents={[agent('tu_1', 'Explore')]} rate={90000} anomalies={[]} onSelectRealAgent={vi.fn()} />,
    );
    expect(getByRole('button', { name: /Explore/i }).getAttribute('tabindex')).toBe('0');
  });
});
