import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePermissionRequestSync } from './usePermissionRequestSync';
import { usePostToolFlagSync } from './usePostToolFlagSync';
import { AetherStoreProvider, useAetherStore } from './store';
import type { PermissionRequestUI, PostToolFlagRequestUI } from './types';
import type { ReactNode } from 'react';

function wrapper({ children }: { children: ReactNode }) {
  return <AetherStoreProvider>{children}</AetherStoreProvider>;
}

const permissionRequest: PermissionRequestUI = {
  requestId: 'r1',
  toolName: 'Write',
  toolInput: { file_path: 'x.ts' },
  risk: 'MED',
  editableField: null,
};

const flagRequest: PostToolFlagRequestUI = {
  requestId: 'f1',
  toolUseId: 't1',
  toolName: 'Bash',
  anomalyKind: 'stalledPermission',
  detail: 'ran 90s',
};

afterEach(() => {
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

// electron/main.ts's permission:respond / postToolFlag:respond handlers push a
// `null` payload down the SAME onRequest channel once a request is answered.
// These tests pin that the renderer's only production dispatch site for
// SET_PENDING_* can actually deliver that null -- without it the badge/tile/
// approvals queue stay non-zero forever after the first real request.
describe('usePermissionRequestSync', () => {
  it('sets pendingPermissionRequest when a request arrives, then clears it on a null payload', () => {
    let emit: ((request: PermissionRequestUI | null) => void) | undefined;
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      permission: {
        onRequest: (cb: (request: PermissionRequestUI | null) => void) => {
          emit = cb;
          return () => { emit = undefined; };
        },
      },
    };

    const { result } = renderHook(
      () => {
        usePermissionRequestSync();
        return useAetherStore().state;
      },
      { wrapper },
    );

    expect(result.current.pendingPermissionRequest).toBeNull();

    act(() => emit?.(permissionRequest));
    expect(result.current.pendingPermissionRequest).toEqual(permissionRequest);
    expect(result.current.notifs[0].m).toContain('Write');

    act(() => emit?.(null));
    expect(result.current.pendingPermissionRequest).toBeNull();
    expect(result.current.notifs[0].m.toLowerCase()).toContain('resolved');
  });

  it('does nothing when window.aetherElectron.permission is absent', () => {
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {};
    const { result } = renderHook(
      () => {
        usePermissionRequestSync();
        return useAetherStore().state.pendingPermissionRequest;
      },
      { wrapper },
    );
    expect(result.current).toBeNull();
  });
});

describe('usePostToolFlagSync', () => {
  it('sets pendingPostToolFlag when a flag arrives, then clears it on a null payload', () => {
    let emit: ((request: PostToolFlagRequestUI | null) => void) | undefined;
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      postToolFlag: {
        onRequest: (cb: (request: PostToolFlagRequestUI | null) => void) => {
          emit = cb;
          return () => { emit = undefined; };
        },
      },
    };

    const { result } = renderHook(
      () => {
        usePostToolFlagSync();
        return useAetherStore().state;
      },
      { wrapper },
    );

    expect(result.current.pendingPostToolFlag).toBeNull();

    act(() => emit?.(flagRequest));
    expect(result.current.pendingPostToolFlag).toEqual(flagRequest);
    expect(result.current.notifs[0].m).toContain('Bash');

    act(() => emit?.(null));
    expect(result.current.pendingPostToolFlag).toBeNull();
    expect(result.current.notifs[0].m.toLowerCase()).toContain('resolved');
  });

  it('does nothing when window.aetherElectron.postToolFlag is absent', () => {
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {};
    const { result } = renderHook(
      () => {
        usePostToolFlagSync();
        return useAetherStore().state.pendingPostToolFlag;
      },
      { wrapper },
    );
    expect(result.current).toBeNull();
  });
});
