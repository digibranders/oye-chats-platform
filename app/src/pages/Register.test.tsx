import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Register from './Register';

const registerClient = vi.fn();
vi.mock('../services/api', () => ({
  registerClient: (...args: unknown[]) => registerClient(...args),
}));
vi.mock('./auth/GoogleAuthButton', () => ({ GoogleAuthButton: () => null }));

function renderRegister(entry = '/register') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/register" element={<Register />} />
          <Route path="/login" element={<div>SIGN IN</div>} />
          <Route path="/verify-email" element={<div>VERIFY</div>} />
          <Route path="/" element={<div>HOME</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function fillForm() {
  fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: 'Priya Sharma' } });
  fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'priya@acme.test' } });
  fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'lantern42' } });
}

describe('Register', () => {
  afterEach(() => {
    registerClient.mockReset();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('asks for three things, and nothing about billing', () => {
    renderRegister();

    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/work email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password/i)).toBeInTheDocument();
    // Cut deliberately: the server resolves the billing country from the
    // request's edge headers, and the question arrived before any price had
    // been shown. Company and website are asked where they are used.
    expect(screen.queryByLabelText(/billing country/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/company/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/confirm password/i)).not.toBeInTheDocument();
  });

  it('shows the password rules before the first keystroke', () => {
    renderRegister();

    expect(screen.getByText('At least 8 characters')).toBeInTheDocument();
    expect(screen.getByText('One letter')).toBeInTheDocument();
    expect(screen.getByText('One number')).toBeInTheDocument();
  });

  it('sends the signup on to verification', async () => {
    registerClient.mockResolvedValue({
      access_token: 'k',
      name: 'Priya Sharma',
      client_id: 12,
      is_verified: false,
    });

    renderRegister();
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText('VERIFY')).toBeInTheDocument();
    expect(localStorage.getItem('admin_pending_email')).toBe('priya@acme.test');
  });

  it('stays on the page when the address is already taken', async () => {
    // It used to navigate to the sign-in page with the error cleared, so from
    // the visitor's side "Create account" simply moved them somewhere else with
    // no explanation of why.
    registerClient.mockRejectedValue(Object.assign(new Error('Email already registered'), { status: 409 }));

    renderRegister();
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/that email already has an account/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('link', { name: /^sign in$/i })[0]);
    expect(await screen.findByText('SIGN IN')).toBeInTheDocument();
  });

  it('keeps a campaign code without writing storage during render', async () => {
    registerClient.mockResolvedValue({ access_token: 'k', name: 'Priya', client_id: 12 });

    renderRegister('/register?code=LAUNCH50');
    await waitFor(() => expect(sessionStorage.getItem('oyechats_promo_code')).toBe('LAUNCH50'));

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() =>
      expect(registerClient).toHaveBeenCalledWith(
        'Priya Sharma',
        'priya@acme.test',
        'lantern42',
        null,
        null,
        null,
        'LAUNCH50',
      ),
    );
  });

  it('refuses a password the server would reject, before asking it', async () => {
    renderRegister();
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: 'Priya' } });
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'priya@acme.test' } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'short1' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/needs 8 characters, a letter and a number/i)).toBeInTheDocument();
    expect(registerClient).not.toHaveBeenCalled();
  });
});
