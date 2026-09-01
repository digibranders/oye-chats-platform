import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Register from './Register';

const registerClient = vi.fn();
const detectCountry = vi.fn();
vi.mock('../services/api', () => ({
  registerClient: (...args: unknown[]) => registerClient(...args),
  detectCountry: (...args: unknown[]) => detectCountry(...args),
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

/**
 * Fill every required field, INCLUDING waiting for the country prefill.
 *
 * The wait is not incidental. `billing_country` is required, and it is the one
 * field a person does not type -- it arrives from `detectCountry`. A submit
 * fired before that resolves is a submit against an invalid form, which is
 * exactly the race a real fast typist can lose too.
 */
async function fillForm() {
  fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: 'Priya Sharma' } });
  fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'priya@acme.test' } });
  fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'lantern42' } });
  await waitFor(() => expect(screen.getByLabelText(/^country/i)).toHaveTextContent(/india/i));
}

describe('Register', () => {
  beforeEach(() => {
    // The edge placed the visitor. Individual tests override this to cover the
    // unplaced case and the slow-response case.
    detectCountry.mockResolvedValue('IN');
  });

  afterEach(() => {
    registerClient.mockReset();
    detectCountry.mockReset();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('asks for four things: name, email, country, password', () => {
    renderRegister();

    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/work email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^country/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password/i)).toBeInTheDocument();

    // Country was cut from this form once, on the reasoning that the server
    // resolves it from edge headers and the question arrived before any price
    // had been shown. The first half of that turned out not to hold: the charge
    // gate REFUSES to bill on an edge signal (409 `billing_country_required`,
    // see `subscription_routes.get_billing_geo`), because an IP is display-grade
    // and a VPN picking INR over USD is a money bug. So the question was not
    // avoided by cutting it, only moved -- to mid-checkout, which is the worst
    // screen to interrupt. Asked here, prefilled from the same signal, it costs
    // one already-answered field instead.
    //
    // Company and website stay out: both are asked where they are used.
    expect(screen.queryByLabelText(/company/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/website/i)).not.toBeInTheDocument();
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
    await fillForm();
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
    await fillForm();
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

    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() =>
      expect(registerClient).toHaveBeenCalledWith(
        'Priya Sharma',
        'priya@acme.test',
        'lantern42',
        null,
        null,
        'IN',
        'LAUNCH50',
      ),
    );
  });

  it('prefills the country the edge placed the visitor in', async () => {
    detectCountry.mockResolvedValue('IN');
    renderRegister();
    await waitFor(() => expect(screen.getByLabelText(/^country/i)).toHaveTextContent(/india/i));
  });

  it('sends the confirmed country on to the server', async () => {
    detectCountry.mockResolvedValue('US');
    registerClient.mockResolvedValue({ access_token: 'k', name: 'Priya', client_id: 12 });

    renderRegister();
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: 'Priya Sharma' } });
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'priya@acme.test' } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'lantern42' } });
    await waitFor(() => expect(screen.getByLabelText(/^country/i)).toHaveTextContent(/united states/i));
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    // The value reaches `billing_country`, so the account starts on the right
    // tax rail and checkout never has to 409 `billing_country_required`.
    await waitFor(() =>
      expect(registerClient).toHaveBeenCalledWith(
        'Priya Sharma',
        'priya@acme.test',
        'lantern42',
        null,
        null,
        'US',
        null,
      ),
    );
  });

  it('does not guess a country the edge could not place', async () => {
    // Local dev, a stripped proxy, a direct origin hit. Defaulting to the
    // primary market here would put a US customer on the INR rail without ever
    // asking them, which is the failure this field exists to prevent.
    detectCountry.mockResolvedValue(null);
    renderRegister();

    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: 'Priya Sharma' } });
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'priya@acme.test' } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'lantern42' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/choose the country you are billed in/i)).toBeInTheDocument();
    expect(registerClient).not.toHaveBeenCalled();
  });

  it('survives a detect that fails outright', async () => {
    // An optional convenience must not take down the signup form.
    detectCountry.mockRejectedValue(new Error('offline'));
    renderRegister();

    expect(await screen.findByLabelText(/^country/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
  });

  it('forwards a ?country= override to the detector', async () => {
    // The reason this exists: localhost sits behind no edge network, so
    // detection correctly returns null and the prefill can never be seen
    // working. The parameter makes it exercisable.
    detectCountry.mockResolvedValue('IN');
    renderRegister('/register?country=IN');
    await waitFor(() => expect(detectCountry).toHaveBeenCalledWith('IN'));
    await waitFor(() => expect(screen.getByLabelText(/^country/i)).toHaveTextContent(/india/i));
  });

  it('passes nothing when there is no override', async () => {
    detectCountry.mockResolvedValue('IN');
    renderRegister();
    await waitFor(() => expect(detectCountry).toHaveBeenCalledWith(null));
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
