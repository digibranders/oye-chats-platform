import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceProvider, useWorkspace } from './WorkspaceContext';

const getMyWorkspaces = vi.fn();

vi.mock('../services/api', () => ({
  getMyWorkspaces: () => getMyWorkspaces(),
  rotateWorkspaceAbort: vi.fn(),
}));

function Probe() {
  const { isOperator, isLoading } = useWorkspace();
  return <p>{isLoading ? 'loading' : isOperator ? 'operator' : 'not operator'}</p>;
}

function mount() {
  return render(
    <WorkspaceProvider>
      <Probe />
    </WorkspaceProvider>,
  );
}

afterEach(() => {
  getMyWorkspaces.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

describe('WorkspaceProvider seat gating', () => {
  it('gates a legacy operator session, which never loads a membership list', async () => {
    // `POST /auth/operator-login` writes no `current_workspace_role`, so the
    // seat has to come from the credential type. Without it the operator saw
    // owner navigation with no route guard behind it.
    localStorage.setItem('admin_token', 'operator-key');
    localStorage.setItem('auth_type', 'operator');

    mount();

    expect(await screen.findByText('operator')).toBeInTheDocument();
    expect(getMyWorkspaces).not.toHaveBeenCalled();
  });

  it('leaves an owner ungated', async () => {
    localStorage.setItem('admin_token', 'client-key');
    localStorage.setItem('auth_type', 'client');
    getMyWorkspaces.mockResolvedValue({
      workspaces: [{ id: 1, name: 'Acme', role: 'owner', bot_count: 2 }],
    });

    mount();

    expect(await screen.findByText('not operator')).toBeInTheDocument();
    await waitFor(() => expect(getMyWorkspaces).toHaveBeenCalled());
  });

  it('gates an invited member whose seat is operator', async () => {
    localStorage.setItem('admin_token', 'client-key');
    localStorage.setItem('auth_type', 'client');
    localStorage.setItem('current_workspace_id', '2');
    localStorage.setItem('current_workspace_role', 'operator');
    getMyWorkspaces.mockResolvedValue({
      workspaces: [{ id: 2, name: 'Globex', role: 'member', operator_role: 'operator', bot_count: 1 }],
    });

    mount();

    expect(await screen.findByText('operator')).toBeInTheDocument();
  });
});
