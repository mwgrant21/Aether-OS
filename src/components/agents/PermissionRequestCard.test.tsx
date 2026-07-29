import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { PermissionRequestCard } from './PermissionRequestCard';
import type { PermissionRequestUI } from '../../state/types';

afterEach(cleanup);

function Setter({ request }: { request: PermissionRequestUI | null }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    dispatch({ type: 'SET_PENDING_PERMISSION_REQUEST', request });
  }, [dispatch, request]);
  return null;
}

function renderWithRequest(request: PermissionRequestUI | null) {
  return render(
    <AetherStoreProvider>
      <Setter request={request} />
      <PermissionRequestCard />
    </AetherStoreProvider>,
  );
}

const BASH_REQUEST: PermissionRequestUI = {
  requestId: 'req-1',
  toolName: 'Bash',
  toolInput: { command: 'rm -rf x' },
  risk: 'HIGH',
  editableField: { label: 'command', value: 'rm -rf x' },
};

describe('PermissionRequestCard', () => {
  let respond: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    respond = vi.fn().mockResolvedValue(undefined);
    (window as any).aetherElectron = {
      permission: {
        onRequest: () => () => {},
        respond,
      },
    };
  });

  it('renders nothing when pendingPermissionRequest is null', () => {
    const { container } = renderWithRequest(null);
    expect(container.textContent).toBe('');
  });

  it('renders tool name, risk badge, and the editable field pre-filled with its value', () => {
    renderWithRequest(BASH_REQUEST);
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText(/high/i)).toBeTruthy();
    expect(screen.getByDisplayValue('rm -rf x')).toBeTruthy();
  });

  it('clicking Approve calls respond with allow + updatedInput mapped back into the right tool_input key', () => {
    renderWithRequest(BASH_REQUEST);
    const input = screen.getByDisplayValue('rm -rf x');
    fireEvent.change(input, { target: { value: 'ls -la' } });
    fireEvent.click(screen.getByText(/approve/i));
    expect(respond).toHaveBeenCalledWith('req-1', { behavior: 'allow', updatedInput: { command: 'ls -la' } });
  });

  it('clicking Deny requires a non-empty reason and calls respond with it', () => {
    renderWithRequest(BASH_REQUEST);

    // Attempt to deny with no reason typed -- must not call respond.
    fireEvent.click(screen.getByText(/deny/i));
    expect(respond).not.toHaveBeenCalled();

    const reasonInput = screen.getByPlaceholderText(/reason/i);
    fireEvent.change(reasonInput, { target: { value: 'too risky' } });
    fireEvent.click(screen.getByText(/deny/i));
    expect(respond).toHaveBeenCalledWith('req-1', { behavior: 'deny', reason: 'too risky' });
  });
});
