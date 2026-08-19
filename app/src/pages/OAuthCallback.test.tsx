import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OAuthCallback from './OAuthCallback';

const getCurrentUser = vi.fn();
vi.mock('../services/api', () => ({ getCurrentUser: () => getCurrentUser() }));

function renderCallback(entry: string, fragment = '#api_key=oauth-key') {
  window.location.hash = fragment;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/auth/callback" element={<OAuthCallback />} />
          <Route path="/" element={<div>HOME</div>} />
          <Route path="/login" element={<div>SIGN IN</div>} />
          <Route path="/inbox" element={<div>INBOX</div>} />
          <Route path="/settings/affiliate" element={<div>PARTNERS</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OAuthCallback', () => {
  afterEach(() => {
    getCurrentUser.mockReset();
    localStorage.clear();
    sessionStorage.clear();
    window.location.hash = '';
  });

  it('signs a returning customer in and lands them home', async () => {
    getCurrentUser.mockResolvedValue({ id: 4, name: 'Priya', bot_count: 3 });

    renderCallback('/auth/callback');

    expect(await screen.findByText('HOME')).toBeInTheDocument();
    expect(localStorage.getItem('admin_token')).toBe('oauth-key');
    // Google verified the address at source, so the email gate is satisfied.
    expect(localStorage.getItem('admin_is_verified')).toBe('true');
  });

  it('sends a brand new account to Home too, in step with the verify screen', async () => {
    // The two used to disagree: this page read `onboarding_complete` and
    // `bot_count` to choose a wizard, while the verification screen sent every
    // fresh signup to the same wizard unconditionally. Home derives the setup
    // checklist from server state, so it is right for both without guessing.
    getCurrentUser.mockResolvedValue({ id: 9, name: 'New', bot_count: 0, onboarding_complete: false });

    renderCallback('/auth/callback?new=1');

    expect(await screen.findByText('HOME')).toBeInTheDocument();
  });

  it('honours a deep link', async () => {
    getCurrentUser.mockResolvedValue({ id: 4, name: 'Priya' });

    renderCallback('/auth/callback?next=%2Finbox');

    expect(await screen.findByText('INBOX')).toBeInTheDocument();
  });

  it('refuses an off-site next', async () => {
    getCurrentUser.mockResolvedValue({ id: 4, name: 'Priya' });

    renderCallback('/auth/callback?next=%2F%2Fevil.example');

    expect(await screen.findByText('HOME')).toBeInTheDocument();
  });

  it('routes a partner who is not a customer to the partner area', async () => {
    getCurrentUser.mockResolvedValue({ id: 4, name: 'Priya', is_affiliate_only: true });

    renderCallback('/auth/callback');

    expect(await screen.findByText('PARTNERS')).toBeInTheDocument();
  });

  it('explains a failed /auth/me instead of bouncing through a silent loop', async () => {
    // It used to navigate to "/" regardless, where a bad token tripped the 401
    // interceptor and returned the user to the sign-in page with no
    // explanation — a sign-in button that appeared to do nothing.
    getCurrentUser.mockRejectedValue(new Error('offline'));

    renderCallback('/auth/callback');

    expect(await screen.findByText(/could not load your account/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText('HOME')).not.toBeInTheDocument();
  });

  it('takes the unconfirmed session with it when the user starts over', async () => {
    getCurrentUser.mockRejectedValue(new Error('offline'));

    renderCallback('/auth/callback');
    (await screen.findByRole('button', { name: /back to sign in/i })).click();

    await waitFor(() => expect(screen.getByText('SIGN IN')).toBeInTheDocument());
    expect(localStorage.getItem('admin_token')).toBeNull();
  });

  it('puts the backend’s own words on a provider failure', async () => {
    renderCallback('/auth/callback?error=oauth_cancelled', '');

    expect(await screen.findByText(/sign-in was cancelled/i)).toBeInTheDocument();
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it('treats a callback with no credential as a failed sign-in', async () => {
    renderCallback('/auth/callback', '');

    expect(await screen.findByText(/the sign-in link was incomplete/i)).toBeInTheDocument();
  });
});
