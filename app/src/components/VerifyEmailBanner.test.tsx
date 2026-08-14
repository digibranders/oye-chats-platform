import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VerifyEmailBanner from './VerifyEmailBanner';

// The banner confirms verification state against /auth/me on mount, so the API
// client is mocked and the tests drive only the render decision.
const getCurrentUser = vi.fn();
const resendVerification = vi.fn();
vi.mock('../services/api', () => ({
  getCurrentUser: () => getCurrentUser(),
  resendVerification: (email: string) => resendVerification(email),
}));

function renderBanner() {
  return render(
    <MemoryRouter>
      <VerifyEmailBanner />
    </MemoryRouter>,
  );
}

/** Every key across both web stores - used to prove dismissal isn't persisted. */
function allStorageKeys(): string[] {
  return [...Object.keys(localStorage), ...Object.keys(sessionStorage)];
}

describe('VerifyEmailBanner', () => {
  afterEach(() => {
    getCurrentUser.mockReset();
    resendVerification.mockReset();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('nudges an unverified account', async () => {
    // The real prod shape that exposed this defect: client 18, Gaurav @ Fynix.
    getCurrentUser.mockResolvedValue({
      name: 'Gaurav',
      email: 'gaurav@fynix.digital',
      company_name: 'Fynix',
      is_verified: false,
    });

    renderBanner();

    await screen.findByRole('status');
    expect(screen.getByText(/Verify your email/i)).toBeInTheDocument();
    // The action must lead somewhere real, with the address pre-filled so
    // /verify-email never dead-ends on a missing email.
    expect(screen.getByRole('link', { name: /Verify now/i })).toHaveAttribute(
      'href',
      '/verify-email?email=gaurav%40fynix.digital',
    );
  });

  it('renders nothing for a verified account', async () => {
    getCurrentUser.mockResolvedValue({
      name: 'Gaurav',
      email: 'gaurav@fynix.digital',
      is_verified: true,
    });

    const { container } = renderBanner();

    // Let the /auth/me effect settle, then assert it stayed hidden.
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stays hidden while verification state is unknown', async () => {
    // A failed /auth/me must not flash a verification warning at someone who
    // may well be verified - default hidden.
    getCurrentUser.mockRejectedValue(new Error('network'));

    const { container } = renderBanner();

    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('dismisses without persisting, so the nudge returns on reload', async () => {
    getCurrentUser.mockResolvedValue({ email: 'gaurav@fynix.digital', is_verified: false });

    const { unmount } = renderBanner();
    await screen.findByRole('status');

    fireEvent.click(screen.getByRole('button', { name: /Dismiss/i }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // Dismissal is in-memory only. The banner does cache `admin_is_verified`,
    // but nothing records the dismissal itself - so a fresh mount (reload or a
    // new session) surfaces the nudge again rather than silencing it forever.
    expect(allStorageKeys().some((key) => /dismiss/i.test(key))).toBe(false);

    unmount();
    renderBanner();
    await screen.findByRole('status');
  });
});
