import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The team-invite airlock's rendered answers.
 *
 * The decision itself is pinned in `settingsModel.test.ts`; what is checked here
 * is that each answer is actually different on screen — a used invitation, a
 * broken link and a wrong account are three different problems with three
 * different ways forward, and the previous page rendered two of them the same.
 */

const api = vi.hoisted(() => ({
  getInvitePublic: vi.fn(),
  acceptInvitePublic: vi.fn(),
  getCurrentUser: vi.fn(),
}));
vi.mock('../../services/api', () => api);

const storage = vi.hoisted(() => ({
  getAuthItem: vi.fn<(key: string) => string | null>(() => null),
  setAuthBundle: vi.fn(),
  clearAuthStorage: vi.fn(),
}));
vi.mock('../../utils/authStorage', () => storage);
vi.mock('../../utils/impersonation', () => ({
  endImpersonationSessionFromSignOut: () => false,
}));

const { InviteAirlock } = await import('./InviteAirlock');

// A menu, a dialog and a mutation sit comfortably inside the default 5s budget
// in isolation, and comfortably outside it when the whole suite runs in
// parallel on a loaded machine. This is a statement about the runner, not about
// what is being asserted — the assertions themselves all settle in milliseconds.
vi.setConfig({ testTimeout: 20_000 });

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/invite/tok123']}>
        <Routes>
          <Route path="/invite/:token" element={<InviteAirlock />} />
          <Route path="/login" element={<p>Sign in</p>} />
          <Route path="/inbox" element={<p>Inbox</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  storage.getAuthItem.mockReturnValue(null);
  api.getInvitePublic.mockResolvedValue({
    status: 'pending',
    email: 'anil@acme.com',
    workspace_name: 'Acme',
    inviter_name: 'Priya',
    role: 'operator',
  });
  api.getCurrentUser.mockResolvedValue({ id: 9, email: 'anil@acme.com', kind: 'client' });
  api.acceptInvitePublic.mockResolvedValue({
    workspace_id: 42,
    workspace_name: 'Acme',
    role: 'operator',
  });
});

describe('InviteAirlock', () => {
  it('offers both doors to a signed-out invitee, carrying the token', async () => {
    renderPage();
    await screen.findByText('Join Acme');
    expect(screen.getByRole('link', { name: /create an account/i }).getAttribute('href')).toContain(
      'next=%2Finvite%2Ftok123',
    );
    expect(
      screen.getByRole('link', { name: /i already have an account/i }).getAttribute('href'),
    ).toContain('email=anil%40acme.com');
  });

  it('says what the invited role can actually do', async () => {
    renderPage();
    expect(await screen.findByText(/answer live conversations and see leads/i)).toBeInTheDocument();
  });

  it('distinguishes a used invitation from a broken link', async () => {
    api.getInvitePublic.mockResolvedValue({ status: 'accepted', email: 'a@b.com' });
    renderPage();
    expect(
      await screen.findByText('This invitation has already been used'),
    ).toBeInTheDocument();
  });

  it('says an expired invitation is expired, and how to get another', async () => {
    api.getInvitePublic.mockResolvedValue({ status: 'expired', email: 'a@b.com' });
    renderPage();
    expect(await screen.findByText('This invitation has expired')).toBeInTheDocument();
    expect(screen.getByText(/ask whoever invited you to send a fresh one/i)).toBeInTheDocument();
  });

  it('reports a bad token as a bad link, not as an expiry', async () => {
    api.getInvitePublic.mockRejectedValue(new Error('not found'));
    renderPage();
    expect(await screen.findByText('This invitation link is not valid')).toBeInTheDocument();
  });

  it('accepts for the right account and stores the joined workspace before leaving', async () => {
    const user = userEvent.setup();
    storage.getAuthItem.mockImplementation((key: string) =>
      key === 'admin_token' ? 'session' : null,
    );
    renderPage();
    await screen.findByRole('button', { name: /accept invitation/i });

    await user.click(screen.getByRole('button', { name: /accept invitation/i }));
    await waitFor(() => expect(api.acceptInvitePublic).toHaveBeenCalledWith('tok123'));
    // Persisted before navigation, or the shell hydrates into the invitee's own
    // empty workspace and then switches under them.
    expect(storage.setAuthBundle).toHaveBeenCalledWith(
      expect.objectContaining({ current_workspace_id: '42', current_workspace_role: 'operator' }),
    );
  });

  it('never silently joins the wrong account', async () => {
    storage.getAuthItem.mockImplementation((key: string) =>
      key === 'admin_token' ? 'session' : null,
    );
    api.getCurrentUser.mockResolvedValue({ id: 1, email: 'someone@else.com', kind: 'client' });
    renderPage();
    expect(
      await screen.findByText('This invitation is for a different account'),
    ).toBeInTheDocument();
    expect(api.acceptInvitePublic).not.toHaveBeenCalled();
  });

  it('stops a team-seat session before the accept button, not after it', async () => {
    storage.getAuthItem.mockImplementation((key: string) => {
      if (key === 'admin_token') return 'session';
      if (key === 'auth_type') return 'operator';
      return null;
    });
    renderPage();
    expect(await screen.findByText('Sign in with your own account')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /accept invitation/i })).not.toBeInTheDocument();
    expect(api.getCurrentUser).not.toHaveBeenCalled();
  });
});
