import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/" element={<div>HOME PAGE</div>} />
        <Route path="/launch" element={<div>LAUNCH STUDIO</div>} />
        <Route path="/workspace/billing" element={<div>BILLING PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Type the 6-digit code into the OTP boxes. */
function enterOtp(code: string) {
  code.split('').forEach((digit, i) => {
    fireEvent.change(screen.getByLabelText(`Digit ${i + 1}`), { target: { value: digit } });
  });
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
    // THE lockout case, and what the whole verification gate rests on: a user
    // logging in on a new browser has no `admin_pending_email` (only
    // Register.jsx ever writes it) and no ?email= in the URL. Before the
    // fallback, both verify and resend refused to act and the gate would have
    // held them here permanently.
    localStorage.setItem('admin_token', 'tok');
    getCurrentUser.mockResolvedValue({ email: 'gaurav@fynix.digital', is_verified: false });
    verifyEmail.mockResolvedValue({ message: 'ok' });

    renderVerify();

    // The masked address proves the fallback resolved before any submit.
    await screen.findByText(/ga\*\*\*@fynix\.digital/);

    enterOtp('123456');

    await waitFor(() => expect(verifyEmail).toHaveBeenCalledWith('gaurav@fynix.digital', '123456'));
    expect(screen.queryByText(/Email address missing/i)).not.toBeInTheDocument();
  });

  it('can resend on a fresh device too', async () => {
    localStorage.setItem('admin_token', 'tok');
    getCurrentUser.mockResolvedValue({ email: 'gaurav@fynix.digital', is_verified: false });
    resendVerification.mockResolvedValue({ message: 'sent' });

    renderVerify();
    await screen.findByText(/ga\*\*\*@fynix\.digital/);

    fireEvent.click(screen.getByRole('button', { name: /Resend code/i }));

    await waitFor(() =>
      expect(resendVerification).toHaveBeenCalledWith('gaurav@fynix.digital'),
    );
  });

  it('releases a session the server already considers verified', async () => {
    // Self-heals a stale `admin_is_verified: false`. Without this the gate
    // would be a closed loop - redirected in here with no way to prove
    // otherwise, since the account has nothing left to verify.
    localStorage.setItem('admin_token', 'tok');
    localStorage.setItem('admin_is_verified', 'false');
    getCurrentUser.mockResolvedValue({ email: 'gaurav@fynix.digital', is_verified: true });

    renderVerify();

    expect(await screen.findByText('HOME PAGE')).toBeInTheDocument();
    expect(localStorage.getItem('admin_is_verified')).toBe('true');
  });

  it('returns a released session to its original destination', async () => {
    localStorage.setItem('admin_token', 'tok');
    localStorage.setItem('admin_is_verified', 'false');
    getCurrentUser.mockResolvedValue({ email: 'gaurav@fynix.digital', is_verified: true });

    renderVerify('/verify-email?next=%2Fworkspace%2Fbilling');

    expect(await screen.findByText('BILLING PAGE')).toBeInTheDocument();
  });

  it('continues to the intended destination after verifying', async () => {
    localStorage.setItem('admin_token', 'tok');
    getCurrentUser.mockResolvedValue({ email: 'gaurav@fynix.digital', is_verified: false });
    verifyEmail.mockResolvedValue({ message: 'ok' });

    renderVerify('/verify-email?next=%2Fworkspace%2Fbilling');
    await screen.findByText(/ga\*\*\*@fynix\.digital/);

    enterOtp('654321');

    expect(await screen.findByText('BILLING PAGE')).toBeInTheDocument();
    expect(localStorage.getItem('admin_is_verified')).toBe('true');
  });

  it('surfaces an expired code as needing a resend, not a wrong code', async () => {
    localStorage.setItem('admin_token', 'tok');
    getCurrentUser.mockResolvedValue({ email: 'gaurav@fynix.digital', is_verified: false });
    resendVerification.mockResolvedValue({ message: 'sent' });
    // The server's own wording for a lapsed 15-minute OTP.
    verifyEmail.mockRejectedValue(new Error('Code has expired. Please request a new one.'));

    renderVerify();
    await screen.findByText(/ga\*\*\*@fynix\.digital/);

    // Resend first, so the success notice is on screen...
    fireEvent.click(screen.getByRole('button', { name: /Resend code/i }));
    await screen.findByText(/New code sent/i);

    enterOtp('111111');

    // ...then the expiry error must replace it, not sit under a contradicting
    // "New code sent - check your inbox."
    expect(await screen.findByText(/Code has expired\. Please request a new one\./i)).toBeInTheDocument();
    expect(screen.queryByText(/New code sent/i)).not.toBeInTheDocument();
  });
});
