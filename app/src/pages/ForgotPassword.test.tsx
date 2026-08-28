import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ForgotPassword from './ForgotPassword';

const requestPasswordReset = vi.fn();
const resetPassword = vi.fn();
vi.mock('../services/api', () => ({
  requestPasswordReset: (email: string) => requestPasswordReset(email),
  resetPassword: (email: string, otp: string, next: string) => resetPassword(email, otp, next),
}));

function renderForgot() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/forgot-password']}>
        <Routes>
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/login" element={<div>SIGN IN</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Get through step one so the assertions can be about step two. */
async function reachCodeStep() {
  requestPasswordReset.mockResolvedValue({ message: 'sent' });
  renderForgot();
  fireEvent.change(screen.getByLabelText(/email address/i), {
    target: { value: 'gaurav@fynix.digital' },
  });
  fireEvent.click(screen.getByRole('button', { name: /send code/i }));
  await screen.findByLabelText(/six-digit code/i);
}

describe('ForgotPassword', () => {
  afterEach(() => {
    requestPasswordReset.mockReset();
    resetPassword.mockReset();
  });

  it('names the address the code went to, and offers a way to change it', async () => {
    // Step two used to show neither, so a typo in the address was a dead end.
    await reachCodeStep();

    expect(screen.getByText(/ga\*\*\*@fynix\.digital/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use a different email/i })).toBeInTheDocument();
  });

  it('holds resend behind the same cooldown as email verification', async () => {
    await reachCodeStep();

    const resend = screen.getByRole('button', { name: /resend in \d+s/i });
    expect(resend).toBeDisabled();
    expect(requestPasswordReset).toHaveBeenCalledTimes(1);
  });

  it('states the password rules instead of failing the submit to reveal them', async () => {
    await reachCodeStep();

    expect(screen.getByText('At least 8 characters')).toBeInTheDocument();
    expect(screen.getByText('One letter')).toBeInTheDocument();
    expect(screen.getByText('One number')).toBeInTheDocument();
  });

  it('will not submit a short code', async () => {
    await reachCodeStep();

    fireEvent.change(screen.getByLabelText(/six-digit code/i), { target: { value: '123' } });
    fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: 'lantern42' } });
    fireEvent.click(screen.getByRole('button', { name: /set new password/i }));

    expect(await screen.findByText(/the code is 6 digits/i)).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('finishes on a screen the reader controls, not a timer', async () => {
    // The success step used to call `setTimeout(navigate, 2500)` with no
    // cleanup, so it fired after unmount and moved the page out from under
    // anyone still reading it.
    resetPassword.mockResolvedValue({ message: 'done' });
    await reachCodeStep();

    fireEvent.change(screen.getByLabelText(/six-digit code/i), { target: { value: '481203' } });
    fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: 'lantern42' } });
    fireEvent.click(screen.getByRole('button', { name: /set new password/i }));

    expect(await screen.findByText(/password changed/i)).toBeInTheDocument();
    expect(resetPassword).toHaveBeenCalledWith('gaurav@fynix.digital', '481203', 'lantern42');

    // The address is carried across, so signing in is one field rather than two.
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute(
      'href',
      '/login?email=gaurav%40fynix.digital',
    );
  });
});
