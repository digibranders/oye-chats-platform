import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The partner magic link, and the ledger item it closes.
 *
 * `acceptAffiliateInvite` — the endpoint that creates the Client and the
 * Affiliate row atomically and hands back a session — had been written in the
 * API client and never called. The page offered "Create your account" instead,
 * which sent the invitee to ordinary signup, made a plain customer, and bounced
 * them back to accept a second time. The token is one-shot, so any stumble in
 * that round trip burned the invitation.
 */

const api = vi.hoisted(() => ({
  lookupAffiliateInvite: vi.fn(),
  acceptAffiliateInvite: vi.fn(),
  acceptAffiliateInviteExisting: vi.fn(),
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

const { AffiliateInvite } = await import('./AffiliateInvite');

// A menu, a dialog and a mutation sit comfortably inside the default 5s budget
// in isolation, and comfortably outside it when the whole suite runs in
// parallel on a loaded machine. This is a statement about the runner, not about
// what is being asserted — the assertions themselves all settle in milliseconds.
vi.setConfig({ testTimeout: 20_000 });

function renderPage(entry = '/affiliate-invite?token=tok123') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/affiliate-invite" element={<AffiliateInvite />} />
          <Route path="/settings/affiliate" element={<p>Partner dashboard</p>} />
          <Route path="/login" element={<p>Sign in</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function withStatus(status: number, message = 'nope'): Error {
  const error = new Error(message);
  (error as Error & { status: number }).status = status;
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
  storage.getAuthItem.mockReturnValue(null);
  api.lookupAffiliateInvite.mockResolvedValue({
    email: 'partner@acme.com',
    expires_at: '2099-01-01T00:00:00Z',
  });
  api.acceptAffiliateInvite.mockResolvedValue({
    access_token: 'tok-abc',
    client_id: 77,
    name: 'Partner',
    is_affiliate: true,
  });
  api.acceptAffiliateInviteExisting.mockResolvedValue({ is_affiliate: true, message: 'ok' });
});

describe('AffiliateInvite — signed out', () => {
  it('creates the account and accepts in one request, then signs them in', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/You are invited to partner with OyeChats/i);

    await user.type(screen.getByLabelText(/your name/i), 'Partner Person');
    await user.type(screen.getByLabelText(/^password/i), 'hunter2024');
    await user.type(screen.getByLabelText(/company/i), 'Acme Partners');
    await user.click(screen.getByRole('button', { name: /accept and create my account/i }));

    await waitFor(() =>
      expect(api.acceptAffiliateInvite).toHaveBeenCalledWith({
        token: 'tok123',
        name: 'Partner Person',
        password: 'hunter2024',
        companyName: 'Acme Partners',
        website: null,
      }),
    );
    expect(storage.setAuthBundle).toHaveBeenCalledWith(
      expect.objectContaining({ admin_token: 'tok-abc', auth_type: 'client' }),
    );
    expect(await screen.findByText('Partner dashboard')).toBeInTheDocument();
  });

  it('shows the invited address and does not let it be edited', async () => {
    renderPage();
    const email = await screen.findByLabelText(/^email/i);
    expect(email).toHaveValue('partner@acme.com');
    expect(email).toBeDisabled();
  });

  it('refuses a password the server would refuse, at the field', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/You are invited to partner with OyeChats/i);

    await user.type(screen.getByLabelText(/your name/i), 'Partner Person');
    await user.type(screen.getByLabelText(/^password/i), 'short');
    await user.click(screen.getByRole('button', { name: /accept and create my account/i }));

    expect(await screen.findByText(/needs 8 characters, a letter and a number/i)).toBeInTheDocument();
    expect(api.acceptAffiliateInvite).not.toHaveBeenCalled();
  });

  it('still offers sign-in for somebody who already has an account', async () => {
    renderPage();
    const link = await screen.findByRole('link', { name: /sign in to accept/i });
    expect(link.getAttribute('href')).toContain('next=%2Faffiliate-invite%3Ftoken%3Dtok123');
  });
});

describe('AffiliateInvite — the token itself', () => {
  it('says an expired invitation is expired, not that the link is broken', async () => {
    api.lookupAffiliateInvite.mockRejectedValue(withStatus(410));
    renderPage();
    expect(await screen.findByText(/expired or has already been used/i)).toBeInTheDocument();
  });

  it('does not sit on a spinner when there is no token to look up', async () => {
    renderPage('/affiliate-invite');
    expect(
      await screen.findByText(/missing its invitation token/i),
    ).toBeInTheDocument();
    expect(api.lookupAffiliateInvite).not.toHaveBeenCalled();
  });
});

describe('AffiliateInvite — signed in', () => {
  it('accepts against the current account and points at the dashboard', async () => {
    storage.getAuthItem.mockImplementation((key: string) =>
      key === 'admin_token' ? 'existing' : null,
    );
    renderPage();
    expect(await screen.findByText(/You are in the partner programme/i)).toBeInTheDocument();
    expect(api.acceptAffiliateInviteExisting).toHaveBeenCalledWith('tok123');
  });

  it('treats "already an affiliate" as success, because it is the desired state', async () => {
    storage.getAuthItem.mockImplementation((key: string) =>
      key === 'admin_token' ? 'existing' : null,
    );
    api.acceptAffiliateInviteExisting.mockRejectedValue(withStatus(409));
    renderPage();
    expect(await screen.findByText(/You are in the partner programme/i)).toBeInTheDocument();
  });

  it('offers a way out rather than an error when the wrong account is signed in', async () => {
    storage.getAuthItem.mockImplementation((key: string) =>
      key === 'admin_token' ? 'existing' : null,
    );
    api.acceptAffiliateInviteExisting.mockRejectedValue(withStatus(403));
    renderPage();
    expect(
      await screen.findByText(/This invitation is for a different account/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /sign out and use partner@acme.com/i }),
    ).toBeInTheDocument();
  });
});
