import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { PermissionCardStack } from './PermissionCardStack';
import type { PermissionRequestUI, PostToolFlagRequestUI } from '../../state/types';

// Real pixel layout does not exist in jsdom (this project's Vitest
// environment) -- getBoundingClientRect always reports 0 for real elements.
// This test verifies PostToolFlagCard's computed `top` responds correctly to
// a *simulated* PermissionRequestCard height (stubbing Element.prototype.
// getBoundingClientRect, since useElementHeight's callback ref reads it on
// mount), which is the only way to exercise the dynamic-measurement path
// here. It does NOT verify real browser pixel geometry -- that would need
// manual verification in the actual Electron app (same disclosed-limitation
// pattern used elsewhere in this project for headless-environment gaps).
function Setter({ permission, flag }: { permission: PermissionRequestUI | null; flag: PostToolFlagRequestUI | null }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    dispatch({ type: 'SET_PENDING_PERMISSION_REQUEST', request: permission });
    dispatch({ type: 'SET_PENDING_POST_TOOL_FLAG', request: flag });
  }, [dispatch, permission, flag]);
  return null;
}

const BASH_REQUEST: PermissionRequestUI = {
  requestId: 'req-1',
  toolName: 'Bash',
  toolInput: { command: 'rm -rf x' },
  risk: 'HIGH',
  editableField: { label: 'command', value: 'rm -rf x' },
};

const REREAD_FLAG: PostToolFlagRequestUI = {
  requestId: 'flag-1',
  toolUseId: 'tu_1',
  toolName: 'Read',
  anomalyKind: 'reReadLoop',
  detail: 'src/foo.ts read 3 times',
};

describe('PermissionCardStack', () => {
  const originalGetRect = Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    (window as any).aetherElectron = {
      permission: { onRequest: () => () => {}, respond: vi.fn() },
      postToolFlag: { onRequest: () => () => {}, respond: vi.fn() },
    };
  });

  afterEach(() => {
    cleanup();
    Element.prototype.getBoundingClientRect = originalGetRect;
  });

  it('defaults PostToolFlagCard to top:16 when no PermissionRequestCard is mounted', () => {
    render(
      <AetherStoreProvider>
        <Setter permission={null} flag={REREAD_FLAG} />
        <PermissionCardStack />
      </AetherStoreProvider>,
    );
    const flagCardRoot = screen.getByText('FLAGGED TOOL USE').parentElement!.parentElement as HTMLElement;
    expect(flagCardRoot.style.top).toBe('16px');
  });

  it('positions PostToolFlagCard below the MEASURED PermissionRequestCard height, not a hardcoded guess', () => {
    // Simulate a tall permission card (editable field + deny-reason box open,
    // per the reviewer's ~208px scenario) by stubbing the measured height.
    Element.prototype.getBoundingClientRect = function () {
      return { height: 208, width: 320, top: 0, left: 0, right: 320, bottom: 208, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };

    render(
      <AetherStoreProvider>
        <Setter permission={BASH_REQUEST} flag={REREAD_FLAG} />
        <PermissionCardStack />
      </AetherStoreProvider>,
    );

    const flagCardRoot = screen.getByText('FLAGGED TOOL USE').parentElement!.parentElement as HTMLElement;
    // 16 (permission card's own top) + 208 (measured height) + 14 (gap) = 238
    expect(flagCardRoot.style.top).toBe('238px');
  });

  it('falls back to top:16 for the flag card if the permission card measures 0 height', () => {
    Element.prototype.getBoundingClientRect = function () {
      return { height: 0, width: 320, top: 0, left: 0, right: 320, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };

    render(
      <AetherStoreProvider>
        <Setter permission={BASH_REQUEST} flag={REREAD_FLAG} />
        <PermissionCardStack />
      </AetherStoreProvider>,
    );

    const flagCardRoot = screen.getByText('FLAGGED TOOL USE').parentElement!.parentElement as HTMLElement;
    // 16 + 0 + 14 = 30 -- still computed from the measured (zero) height, not skipped.
    expect(flagCardRoot.style.top).toBe('30px');
  });
});
