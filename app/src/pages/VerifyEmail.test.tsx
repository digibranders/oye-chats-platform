import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VerifyEmail from './VerifyEmail';

const verifyEmail = vi.fn();
const resendVerification = vi.fn();
const getCurrentUser = vi.fn();
vi.mock('../services/api', () => ({
  verifyEmail: (email: string, otp: string) => verifyEmail(email, otp),
  resendVerification: (email: string) => resendVerification(email),
  getCurrentUser: () => getCurrentUser(),
}));

function renderVerify(entry = '/verify-email') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/" element={<div>HOME</div>} />
          <Route path="/login" element={<div>SIGN IN</div>} />
          <Route path="/billing" element={<div>BILLING</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Put a code into the single one-time-code field. */
function typeCode(code: string) {
  fireEvent.change(screen.getByLabelText(/six-digit code/i), { target: { value: code } });
}

describe('VerifyEmail', () => {
  afterEach(() => {
    verifyEmail.mockReset();
    resendVerification.mockReset();
    getCurrentUser.mockReset();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('resolves the address from /auth/me on a fresh device', async () => {
    // THE lockout case. Only the signup form ever writes `admin_pending_email`,
    // so anyone signing in on a second device arrives with nothing in storage
    // and no `?email=`. Before the fallback both verify and resend refused to
    // act, and the gate held them here permanently.
    localStorage.setItem('admin_token', 'tok');
    getCurrentUser.mockResolvedValue({ email: 'gaurav@fynix.digital', is_verified: false });
    verifyEmail.mockResolvedValue({ message: 'ok' });

    renderVerify();
    await screen.findByText(/ga\*\*\*@fynix\.digital/);

    typeCode('123456');

    await waitFor(() => expect(verifyEmail).toHaveBeenCalledWith('gaurav@fynix.digital', '123456'));
  });

  it('can resend on a fresh device too', async () => {
    localStorage.setItem('admin_token', 'tok');
    getCurrentUser.mockResolvedValue({ email: 'gaurav@fynix.digital', is_verified: false });
    resendVerification.mockResolvedValue({ message: 'sent' });

    renderVerify();
    await screen.findByText(/ga\*\*\*@fynix\.digital/);

    fireEvent.click(screen.getByRole('button', { name: /resend code/i }));

    await waitFor(() => expect(resendVerification).toHaveBeenCalledWith('gaurav@fynix.digital'));
  });

  it('offers a way out when no address can be resolved at all', async () => {
    // The stranded case: both actions need an address, so the screen says so
    // and hands over a real button instead of two controls that refuse.
    localStorage.setItem('admin_token', 'tok');
    getCurrentUser.mockRejectedValue(new Error('offline'));

    renderVerify();

    expect(await screen.findByText(/could not tell which account to verify/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /sign in again/i }));
    expect(await screen.findByText('SIGN IN')).toBeInTheDocument();
    expect(localStorage.getItem('admin_token')).toBeNull();
  });

  it('releases a session the server already considers verified', async () => {
    // Self-heals a stale `admin_is_verified: false`, which would otherwise be a
    // closed loop: held here with nothing left to verify.
    localStorage.setItem('admin_token', 'tok');
    localStorage.setItem('admin_is_verified', 'false');
    getCurrentUser.mockResolvedValue({ email: 'gaurav@fynix.digital', is_verified: true });

    renderVerify();

    expect(await screen.findByText('HOME')).toBeInTheDocument();
    expect(localStorage.getItem('admin_is_verified')).toBe('true');
  });

  it('returns a released session to its original destination', async () => {
    localStorage.setItem('admin_token', 'tok');
    localStorage.setItem('admin_is_verified', 'false');
    getCurrentUser.mockResolvedValue({ email: 'gaurav@fynix.digital', is_verified: true });

    renderVerify('/verify-email?next=%2Fbilling');

    expect(await screen.findByText('BILLING')).toBeInTheDocument();
  });

  it('sends a freshly verified signup to Home, not to a separate onboarding route', async () => {
    // The routing both post-verification paths now agree on. Home opens with
    // the setup checklist and the "create your first chatbot" empty state, both
    // derived from server state, so it is correct for a new account without
    // anyone having to predict that it is one.
    localStorage.setItem('admin_token', 'tok');
    localStorage.setItem('admin_pending_email', 'new@acme.test');
    getCurrentUser.mockResolvedValue({ email: 'new@acme.test', is_verified: false });
    verifyEmail.mockResolvedValue({ message: 'ok' });

    renderVerify();
    typeCode('654321');

    expect(await screen.findByText('HOME')).toBeInTheDocument();
    expect(localStorage.getItem('admin_is_verified')).toBe('true');
    expect(localStorage.getItem('admin_pending_email')).toBeNull();
  });

  it('continues to the intended destination after verifying', async () => {
    localStorage.setItem('admin_token', 'tok');
    localStorage.setItem('admin_pending_email', 'new@acme.test');
    getCurrentUser.mockResolvedValue({ email: 'new@acme.test', is_verified: false });
    verifyEmail.mockResolvedValue({ message: 'ok' });

    renderVerify('/verify-email?next=%2Fbilling');
    typeCode('654321');

    expect(await screen.findByText('BILLING')).toBeInTheDocument();
  });

  it('submits a code repaired in the middle, not only one typed left to right', async () => {
    // The defect this replaces: auto-submit fired only from the last of six
    // boxes, so anyone who backspaced to fix the third digit and retyped it was
    // left holding a complete code that had never been sent, with nothing on
    // screen telling them to press the button.
    localStorage.setItem('admin_token', 'tok');
    localStorage.setItem('admin_pending_email', 'new@acme.test');
    getCurrentUser.mockResolvedValue({ email: 'new@acme.test', is_verified: false });
    verifyEmail.mockRejectedValue(new Error('Invalid code.'));

    renderVerify();

    typeCode('129456');
    await waitFor(() => expect(verifyEmail).toHaveBeenCalledWith('new@acme.test', '129456'));
    await screen.findByText(/invalid code/i);

    // Back to a five-digit value, then complete it again in the middle.
    typeCode('12456');
    typeCode('123456');
    await waitFor(() => expect(verifyEmail).toHaveBeenLastCalledWith('new@acme.test', '123456'));
    expect(verifyEmail).toHaveBeenCalledTimes(2);
  });

  it('surfaces an expired code as needing a resend, not a wrong code', async () => {
    localStorage.setItem('admin_token', 'tok');
    localStorage.setItem('admin_pending_email', 'new@acme.test');
    getCurrentUser.mockResolvedValue({ email: 'new@acme.test', is_verified: false });
    resendVerification.mockResolvedValue({ message: 'sent' });
    verifyEmail.mockRejectedValue(new Error('Code has expired. Please request a new one.'));

    renderVerify();

    fireEvent.click(screen.getByRole('button', { name: /resend code/i }));
    await screen.findByText(/new code sent/i);

    typeCode('111111');

    // The expiry error must replace the confirmation, not sit under a
    // contradicting "New code sent".
    expect(
      await screen.findByText(/code has expired\. please request a new one\./i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/new code sent/i)).not.toBeInTheDocument();
  });

  it('holds the resend button for the cooldown, the same as the reset flow', async () => {
    localStorage.setItem('admin_token', 'tok');
    localStorage.setItem('admin_pending_email', 'new@acme.test');
    getCurrentUser.mockResolvedValue({ email: 'new@acme.test', is_verified: false });
    resendVerification.mockResolvedValue({ message: 'sent' });

    renderVerify();
    fireEvent.click(screen.getByRole('button', { name: /resend code/i }));

    const held = await screen.findByRole('button', { name: /resend in \d+s/i });
    expect(held).toBeDisabled();
  });
});
