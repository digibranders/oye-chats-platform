import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Login from './Login';

const loginAdmin = vi.fn();
const loginOperator = vi.fn();
vi.mock('../services/api', () => ({
  loginAdmin: (email: string, password: string) => loginAdmin(email, password),
  loginOperator: (email: string, password: string) => loginOperator(email, password),
}));

// The Google button probes the API for its own availability. It is not what
// these tests are about, and leaving it in makes every one of them wait on a
// network call that cannot succeed here.
vi.mock('./auth/GoogleAuthButton', () => ({ GoogleAuthButton: () => null }));

function renderLogin(entry = '/login') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<div>HOME</div>} />
          <Route path="/inbox" element={<div>INBOX</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function fillCredentials(email = 'owner@acme.test', password = 'hunter22') {
  fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: password } });
}

const wrongPassword = () => Object.assign(new Error('Incorrect email or password.'), { status: 401 });

describe('Login', () => {
  afterEach(() => {
    loginAdmin.mockReset();
    loginOperator.mockReset();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('spends one request on a wrong password, not two', async () => {
    // The screen this replaces tried the customer endpoint and then the
    // operator endpoint on every failure, so a mistyped customer password cost
    // two round trips before the error appeared — and burned a failed-attempt
    // count against an operator account holding the same address.
    loginAdmin.mockRejectedValue(wrongPassword());

    renderLogin();
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    // The alert's title carries the verdict; its body carries the other door.
    // It used to glue both sentences into one unstyled 160-character run.
    expect(await screen.findByText(/email or password is incorrect/i)).toBeInTheDocument();
    expect(loginAdmin).toHaveBeenCalledTimes(1);
    expect(loginOperator).not.toHaveBeenCalled();
  });

  it('offers the team door explicitly instead of probing it', async () => {
    loginAdmin.mockRejectedValue(wrongPassword());
    loginOperator.mockResolvedValue({
      access_token: 'op-key',
      name: 'Sam',
      client_id: 4,
      operator_id: 9,
      role: 'operator',
    });

    renderLogin();
    fillCredentials('sam@acme.test');
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    fireEvent.click(await screen.findByRole('button', { name: /team sign-in/i }));

    expect(await screen.findByText('INBOX')).toBeInTheDocument();
    expect(loginOperator).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('auth_type')).toBe('operator');
  });

  it('remembers the door that worked, so the next sign-in costs one request', async () => {
    loginAdmin.mockRejectedValue(wrongPassword());
    loginOperator.mockResolvedValue({
      access_token: 'op-key',
      name: 'Sam',
      client_id: 4,
      operator_id: 9,
      role: 'operator',
    });

    const first = renderLogin();
    fillCredentials('sam@acme.test');
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /team sign-in/i }));
    await screen.findByText('INBOX');

    first.unmount();
    localStorage.removeItem('admin_token');
    loginAdmin.mockClear();
    loginOperator.mockClear();

    renderLogin();
    fillCredentials('sam@acme.test');
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => expect(loginOperator).toHaveBeenCalledTimes(1));
    expect(loginAdmin).not.toHaveBeenCalled();
  });

  it('signs a customer in and lands them home', async () => {
    loginAdmin.mockResolvedValue({
      access_token: 'client-key',
      name: 'Priya',
      client_id: 7,
      is_verified: true,
      is_superadmin: false,
    });

    renderLogin();
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByText('HOME')).toBeInTheDocument();
    expect(localStorage.getItem('admin_token')).toBe('client-key');
    expect(localStorage.getItem('auth_type')).toBe('client');
  });

  it('validates before it asks the server', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByText(/enter your email address/i)).toBeInTheDocument();
    expect(await screen.findByText(/enter your password/i)).toBeInTheDocument();
    expect(loginAdmin).not.toHaveBeenCalled();
  });

  it('carries a deep link through the sign-in', async () => {
    loginAdmin.mockResolvedValue({ access_token: 'k', name: 'Priya', client_id: 7 });

    renderLogin('/login?next=%2Finbox');
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByText('INBOX')).toBeInTheDocument();
  });

  it('refuses an off-site redirect smuggled in as next', async () => {
    loginAdmin.mockResolvedValue({ access_token: 'k', name: 'Priya', client_id: 7 });

    renderLogin('/login?next=%2F%2Fevil.example');
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByText('HOME')).toBeInTheDocument();
  });
});
