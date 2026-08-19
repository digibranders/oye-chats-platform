import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '../client';
import { AccessCard, DeleteAccountCard } from './AccessActions';
import { CreditsDialog } from './AccountDialogs';
import { CustomersPage } from './CustomersPage';
import { IdentitiesTab } from './DirectoryTabs';
import { ImpersonateCard } from './Impersonate';
import { SupportSessionsPanel, SupportSessionsProvider } from './SupportSessions';
import { MAX_CREDIT_DELTA, creditAmountProblem, creditDelta, creditReasonProblem } from './credits';
import { isLive, minutesRemaining, sessionState, type SupportSession } from './supportSessionStore';
import type { ClientDetail } from './types';

vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>();
  return {
    ...actual,
    platform: {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      remove: vi.fn(),
    },
  };
});

const mocked = vi.mocked(platform);

const CLIENT: ClientDetail = {
  id: 12,
  name: 'Acme Ltd',
  email: 'ops@acme.com',
  is_superadmin: false,
  superadmin_role: null,
  suspended_at: null,
  website: 'https://acme.com',
  created_at: '2026-01-04T09:00:00Z',
  bots: [
    {
      id: 3,
      bot_key: 'bot-abc123',
      name: 'Support',
      client_id: 12,
      client_name: 'Acme Ltd',
      is_active: true,
      primary_color: null,
      created_at: '2026-01-05T09:00:00Z',
    },
  ],
  subscription: null,
  mrr_cents: 4900,
  total_sessions: 1204,
  total_messages: 8210,
  credits_balance: 1200,
};

function withProvider(node: React.ReactNode) {
  return (
    <MemoryRouter initialEntries={['/platform/customers/12']}>
      <SupportSessionsProvider>{node}</SupportSessionsProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------- pure */

describe('credit adjustment rules', () => {
  it('signs the delta from the direction, so "remove" can never add', () => {
    expect(creditDelta('add', 500)).toBe(500);
    expect(creditDelta('remove', 500)).toBe(-500);
    // A pasted negative in the "add" field must not flip the direction back.
    expect(creditDelta('add', -500)).toBe(500);
    expect(creditDelta('remove', -500)).toBe(-500);
  });

  it('refuses what the API would refuse, with the API’s own numbers', () => {
    expect(creditAmountProblem(0)).toMatch(/above zero/);
    expect(creditAmountProblem(Number.NaN)).toMatch(/above zero/);
    expect(creditAmountProblem(MAX_CREDIT_DELTA + 1)).toMatch(/10,000,000/);
    expect(creditAmountProblem(MAX_CREDIT_DELTA)).toBeNull();
    expect(creditReasonProblem('ok')).toMatch(/at least 3/);
    expect(creditReasonProblem('  a  ')).toMatch(/at least 3/);
    expect(creditReasonProblem('x'.repeat(501))).toMatch(/500 characters/);
    expect(creditReasonProblem('Goodwill for the outage')).toBeNull();
  });
});

describe('support session state', () => {
  const NOW = Date.parse('2026-08-19T12:00:00Z');
  const base: SupportSession = {
    tokenId: 5,
    clientId: 12,
    clientName: 'Acme Ltd',
    clientEmail: 'ops@acme.com',
    expiresAt: '2026-08-19T12:20:00Z',
    mintedAt: '2026-08-19T11:50:00Z',
    revokedAt: null,
    handoffUrl: 'https://app.example/?impersonation=raw',
  };

  it('reads revocation over expiry, and expiry over use', () => {
    expect(sessionState(base, NOW)).toBe('ready');
    expect(sessionState({ ...base, handoffUrl: null }, NOW)).toBe('open');
    expect(sessionState(base, Date.parse('2026-08-19T12:30:00Z'))).toBe('expired');
    expect(sessionState({ ...base, revokedAt: '2026-08-19T11:55:00Z' }, NOW)).toBe('revoked');
    // Revoked stays revoked even once it would also have expired.
    expect(
      sessionState({ ...base, revokedAt: '2026-08-19T11:55:00Z' }, Date.parse('2026-08-19T13:00:00Z')),
    ).toBe('revoked');
  });

  it('treats only a usable token as live, because only that needs revoking', () => {
    expect(isLive(base, NOW)).toBe(true);
    expect(isLive({ ...base, handoffUrl: null }, NOW)).toBe(true);
    expect(isLive({ ...base, revokedAt: '2026-08-19T11:55:00Z' }, NOW)).toBe(false);
    expect(isLive(base, Date.parse('2026-08-19T13:00:00Z'))).toBe(false);
  });

  it('never counts down past zero, and reports an unreadable expiry as unknown', () => {
    expect(minutesRemaining(base, NOW)).toBe(20);
    expect(minutesRemaining(base, Date.parse('2026-08-19T13:00:00Z'))).toBe(0);
    expect(minutesRemaining({ ...base, expiresAt: 'never' }, NOW)).toBeNull();
  });
});

/* ----------------------------------------------------------- impersonation */

describe('Impersonation', () => {
  it('states that the endpoint stores no reason instead of showing a field that goes nowhere', () => {
    render(withProvider(<ImpersonateCard client={CLIENT} />));
    expect(screen.getByText('Not accepted by this endpoint. Nothing is stored.')).toBeInTheDocument();
  });

  it('holds the confirmation until the account’s own email is typed', async () => {
    const user = userEvent.setup();
    render(withProvider(<ImpersonateCard client={CLIENT} />));

    await user.click(screen.getByRole('button', { name: /Open a support session/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Act as Acme Ltd?');

    const confirm = within(dialog).getByRole('button', { name: 'Mint support token' });
    expect(confirm).toBeDisabled();
    expect(mocked.post).not.toHaveBeenCalled();

    // The wrong account's address does not unlock it — the mistake this catches
    // is minting against the row next to the one you meant.
    await user.type(within(dialog).getByRole('textbox'), 'ops@other.com');
    expect(confirm).toBeDisabled();

    await user.clear(within(dialog).getByRole('textbox'));
    await user.type(within(dialog).getByRole('textbox'), 'ops@acme.com');
    expect(confirm).toBeEnabled();
  });

  it('mints a token, never renders it, and offers a revoke control for it', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    vi.stubGlobal('open', open);
    mocked.post.mockResolvedValue({
      token: 'raw-secret-token',
      token_id: 77,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      redirect_url: 'https://app.example/?impersonation=raw-secret-token',
    });

    render(
      withProvider(
        <>
          <ImpersonateCard client={CLIENT} />
          <SupportSessionsPanel clientId={CLIENT.id} />
        </>,
      ),
    );

    await user.click(screen.getByRole('button', { name: /Open a support session/ }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'ops@acme.com');
    await user.click(within(dialog).getByRole('button', { name: 'Mint support token' }));

    await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/clients/12/impersonate'));
    expect(await screen.findByText('#77')).toBeInTheDocument();
    // The raw credential must never reach the DOM.
    expect(document.body.textContent).not.toContain('raw-secret-token');

    await user.click(screen.getByRole('button', { name: /Open support session/ }));
    expect(open).toHaveBeenCalledWith(
      'https://app.example/?impersonation=raw-secret-token',
      '_blank',
      'noopener,noreferrer',
    );

    const revoke = await screen.findByRole('button', { name: 'Revoke' });
    await user.click(revoke);
    const revokeDialog = await screen.findByRole('alertdialog');
    expect(revokeDialog).toHaveTextContent('Revoke the support session for Acme Ltd?');
    mocked.post.mockResolvedValue({ ok: true, revoked_at: new Date().toISOString() });
    await user.click(within(revokeDialog).getByRole('button', { name: 'Revoke session' }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/impersonation/77/revoke'));
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
  });

  it('refuses a super-admin target on the page, not only on the server', async () => {
    render(withProvider(<ImpersonateCard client={{ ...CLIENT, is_superadmin: true }} />));
    expect(screen.getByText('Super-admin accounts cannot be impersonated')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open a support session/ })).toBeDisabled();
  });

  it('says nothing is listed that this console did not mint', () => {
    render(withProvider(<SupportSessionsPanel />));
    expect(screen.getByText('No support session opened from here')).toBeInTheDocument();
    expect(screen.getByText(/exposes no endpoint that lists impersonation tokens/)).toBeInTheDocument();
  });
});

/* --------------------------------------------------------------- deletion */

describe('Deleting a customer', () => {
  it('names what is destroyed and demands the account’s email before it will run', async () => {
    const user = userEvent.setup();
    mocked.remove.mockResolvedValue({ message: 'deleted', deleted_client_id: 12 });
    render(
      <MemoryRouter initialEntries={['/platform/customers/12']}>
        <DeleteAccountCard client={CLIENT} />
      </MemoryRouter>,
    );

    // The consequence is stated before the dialog is even opened.
    expect(screen.getByText(/1 chatbot/)).toBeInTheDocument();
    expect(screen.getByText(/whole knowledge base/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete account' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Delete Acme Ltd and everything they own?');

    const confirm = within(dialog).getByRole('button', { name: 'Delete permanently' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), 'ops@acme.com');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(mocked.remove).toHaveBeenCalledWith('/clients/12'));
  });

  it('surfaces the server’s refusal on the page rather than swallowing it', async () => {
    const user = userEvent.setup();
    mocked.remove.mockRejectedValue(
      Object.assign(new Error('Client has issued tax invoices, which must be retained for GST compliance.'), {
        status: 409,
      }),
    );
    render(
      <MemoryRouter initialEntries={['/platform/customers/12']}>
        <DeleteAccountCard client={CLIENT} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Delete account' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'ops@acme.com');
    await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    expect(await screen.findByText(/must be retained for GST compliance/)).toBeInTheDocument();
  });
});

/* --------------------------------------------------------------- controls */

describe('Access controls', () => {
  it('says what rotating a key breaks, and gates it behind the account email', async () => {
    const user = userEvent.setup();
    mocked.post.mockResolvedValue({ ok: true, api_key_masked: '••••••9f3a' });
    render(
      <MemoryRouter>
        <AccessCard client={CLIENT} onChanged={vi.fn()} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Rotate API key' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('stops authenticating');
    expect(dialog).toHaveTextContent('never returned in full');
    // Accurate, not alarmist: the embedded widget authenticates with a bot key.
    expect(dialog).toHaveTextContent('embedded widgets are unaffected');

    const confirm = within(dialog).getByRole('button', { name: 'Rotate key' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), 'ops@acme.com');
    await user.click(confirm);

    await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/clients/12/rotate-api-key'));
    // Only the masked form is ever shown.
    expect(await screen.findByText('••••••9f3a')).toBeInTheDocument();
  });

  it('confirms a suspension and states that it is reversible', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    mocked.patch.mockResolvedValue({});
    render(
      <MemoryRouter>
        <AccessCard client={CLIENT} onChanged={onChanged} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Suspend account' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('restoring access reverses this exactly');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend account' }));
    await waitFor(() =>
      expect(mocked.patch).toHaveBeenCalledWith('/clients/12', { suspended: true }),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it('sends a reset code without ever showing or setting a password', async () => {
    const user = userEvent.setup();
    mocked.post.mockResolvedValue({ ok: true, message: 'sent' });
    render(
      <MemoryRouter>
        <AccessCard client={CLIENT} onChanged={vi.fn()} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Send reset code' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Their current password keeps working until they use it.');
    await user.click(within(dialog).getByRole('button', { name: 'Send reset code' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/clients/12/reset-password'),
    );
  });
});

describe('Credit adjustment', () => {
  it('reviews the balance before and after before it will spend anything', async () => {
    const user = userEvent.setup();
    mocked.post.mockResolvedValue({ balance: 6200, entry_id: 9 });
    const onSaved = vi.fn();
    render(
      <CreditsDialog client={CLIENT} open onOpenChange={vi.fn()} onSaved={onSaved} />,
    );

    const dialog = await screen.findByRole('dialog');
    const review = within(dialog).getByRole('button', { name: 'Review' });
    expect(review).toBeDisabled();

    await user.type(within(dialog).getByRole('textbox', { name: /Credits/ }), '5000');
    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Goodwill credit for the 14 Aug outage.',
    );
    expect(review).toBeEnabled();
    expect(mocked.post).not.toHaveBeenCalled();

    await user.click(review);
    expect(within(dialog).getByText('Balance after')).toBeInTheDocument();
    expect(within(dialog).getByText('6,200')).toBeInTheDocument();
    expect(within(dialog).getByText(/append-only/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Add 5,000 credits' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/clients/12/credits', {
        delta: 5000,
        reason: 'Goodwill credit for the 14 Aug outage.',
      }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it('sends a negative delta for a removal, and asks in red', async () => {
    const user = userEvent.setup();
    mocked.post.mockResolvedValue({ balance: 200, entry_id: 10 });
    render(<CreditsDialog client={CLIENT} open onOpenChange={vi.fn()} onSaved={vi.fn()} />);

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'Remove credits' }));
    await user.type(within(dialog).getByRole('textbox', { name: /Credits/ }), '1000');
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Reversing a duplicate grant.');
    await user.click(within(dialog).getByRole('button', { name: 'Review' }));

    expect(within(dialog).getByText('200')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove 1,000 credits' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/clients/12/credits', {
        delta: -1000,
        reason: 'Reversing a duplicate grant.',
      }),
    );
  });
});

/* ------------------------------------------------------- across the section */

describe('The customers section', () => {
  it('keeps a live support session visible after navigating away from the account that opened it', async () => {
    // The reason the provider wraps both screens: the token outlives the screen
    // that minted it, and losing sight of it loses the only control that ends it.
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn());
    mocked.get.mockImplementation(async (path: string) => {
      if (path === '/clients/12') return CLIENT;
      if (path === '/clients') return [];
      return [];
    });
    mocked.post.mockResolvedValue({
      token: 'raw-secret-token',
      token_id: 88,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      redirect_url: 'https://app.example/?impersonation=raw-secret-token',
    });

    render(
      <MemoryRouter initialEntries={['/platform/customers/12']}>
        <Routes>
          <Route path="/platform/customers/*" element={<CustomersPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Acme Ltd', level: 1 });
    await user.click(screen.getByRole('button', { name: /Open a support session/ }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'ops@acme.com');
    await user.click(within(dialog).getByRole('button', { name: 'Mint support token' }));
    expect(await screen.findByText('#88')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: /All accounts/ }));
    expect(await screen.findByText('Support sessions in progress')).toBeInTheDocument();
    expect(screen.getByText('#88')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });
});

describe('Sign-in identities', () => {
  it('confirms an unlink and warns that the customer may have no other way in', async () => {
    const user = userEvent.setup();
    mocked.get.mockResolvedValue([
      {
        id: 4,
        client_id: 12,
        client_name: 'Acme Ltd',
        provider: 'google',
        provider_user_id: 'g-1',
        email: 'ops@acme.com',
        picture_url: null,
        created_at: '2026-02-01T09:00:00Z',
        last_login_at: '2026-08-01T09:00:00Z',
      },
    ]);
    mocked.remove.mockResolvedValue({ ok: true });

    render(
      <MemoryRouter initialEntries={['/platform/customers']}>
        <IdentitiesTab />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Unlink' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Unlink google from Acme Ltd?');
    expect(dialog).toHaveTextContent('never set a password');
    expect(mocked.remove).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Unlink identity' }));
    await waitFor(() => expect(mocked.remove).toHaveBeenCalledWith('/oauth-accounts/4'));
  });
});
