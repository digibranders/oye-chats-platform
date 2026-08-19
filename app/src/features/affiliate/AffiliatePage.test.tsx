import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The partner dashboard.
 *
 * Two things it has to get right: a 403 here is "you are not in the invite-only
 * programme", which is an answer rather than a failure, and pausing a code is a
 * money decision that has to say what it costs before it is taken.
 */

const api = vi.hoisted(() => ({
  getAffiliateMe: vi.fn(),
  getAffiliateCodes: vi.fn(),
  getAffiliateStats: vi.fn(),
  getAffiliateCodeReferrals: vi.fn(),
  createAffiliateCode: vi.fn(),
  updateAffiliateCode: vi.fn(),
}));
vi.mock('../../services/api', () => api);

const { AffiliatePage } = await import('./AffiliatePage');

// A menu, a dialog and a mutation sit comfortably inside the default 5s budget
// in isolation, and comfortably outside it when the whole suite runs in
// parallel on a loaded machine. This is a statement about the runner, not about
// what is being asserted — the assertions themselves all settle in milliseconds.
vi.setConfig({ testTimeout: 20_000 });

function code(overrides: Record<string, unknown> = {}) {
  return {
    id: 3,
    code: 'LAUNCH25',
    label: 'Newsletter',
    active: true,
    affiliate_commission_pct: 15,
    customer_discount_pct: 10,
    clicks: 120,
    signups: 6,
    conversion_pct: 5,
    created_at: '2026-01-01T00:00:00Z',
    deactivated_at: null,
    ...overrides,
  };
}

function forbidden(): Error {
  const error = new Error('Not an affiliate');
  (error as Error & { status: number }).status = 403;
  return error;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AffiliatePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getAffiliateMe.mockResolvedValue({ id: 1, max_active_codes: 3, commission_pct: 30 });
  api.getAffiliateCodes.mockResolvedValue([code()]);
  api.getAffiliateStats.mockResolvedValue({
    total_clicks: 120,
    total_signups: 6,
    active_codes: 1,
    max_active_codes: 3,
    conversion_pct: 5,
  });
  api.updateAffiliateCode.mockResolvedValue({});
  api.createAffiliateCode.mockResolvedValue({});
});

describe('AffiliatePage — the four states', () => {
  it('shows a loading placeholder', () => {
    api.getAffiliateMe.mockReturnValue(new Promise(() => {}));
    api.getAffiliateCodes.mockReturnValue(new Promise(() => {}));
    api.getAffiliateStats.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(document.querySelector('[aria-busy]')).not.toBeNull();
  });

  it('reads a 403 as "invite-only", not as a broken page', async () => {
    api.getAffiliateMe.mockRejectedValue(forbidden());
    renderPage();
    expect(
      await screen.findByText('You are not in the partner programme'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/could not load/i)).not.toBeInTheDocument();
  });

  it('reports a real failure as a failure, with a retry', async () => {
    api.getAffiliateStats.mockRejectedValue(new Error('gateway timeout'));
    renderPage();
    expect(
      await screen.findByText('We could not load your affiliate dashboard'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('teaches from the empty state rather than showing a blank table', async () => {
    api.getAffiliateCodes.mockResolvedValue([]);
    api.getAffiliateStats.mockResolvedValue({ active_codes: 0, max_active_codes: 3 });
    renderPage();
    expect(await screen.findByText('No codes yet')).toBeInTheDocument();
    expect(screen.getByText(/keep up to 30%/i)).toBeInTheDocument();
  });
});

describe('AffiliatePage — codes', () => {
  it('gives every code a share link built from the marketing origin', async () => {
    renderPage();
    await screen.findByRole('button', { name: /actions for launch25/i });
    expect(
      screen.getByText('https://www.oyechats.com/?ref=LAUNCH25'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /copy share link for launch25/i }),
    ).toBeInTheDocument();
  });

  it('confirms before pausing a code, and says what stops earning', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /actions for launch25/i });

    await user.click(screen.getByRole('button', { name: /actions for launch25/i }));
    await user.click(await screen.findByRole('menuitem', { name: /pause code/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/no longer attributed to you/i)).toBeInTheDocument();
    expect(api.updateAffiliateCode).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /pause code/i }));
    await waitFor(() =>
      expect(api.updateAffiliateCode).toHaveBeenCalledWith(3, { active: false }),
    );
  });

  it('stops a new code being created past the active-code cap', async () => {
    api.getAffiliateCodes.mockResolvedValue([
      code({ id: 1, code: 'A' }),
      code({ id: 2, code: 'B' }),
      code({ id: 3, code: 'C' }),
    ]);
    renderPage();
    await screen.findByText('You are using all your active codes');
    expect(screen.getByRole('button', { name: /new code/i })).toBeDisabled();
  });

  it('refuses a split that exceeds the pool, before it is sent', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /new code/i });

    await user.click(screen.getByRole('button', { name: /new code/i }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText(/^code/i), 'SPRING');
    const theirs = within(dialog).getByLabelText(/they save/i);
    await user.clear(theirs);
    await user.type(theirs, '20');

    // Pool is 30, the affiliate's own cut defaults to the whole pool.
    expect(within(dialog).getByText(/exceeds your 30% pool/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /create code/i })).toBeDisabled();
    expect(api.createAffiliateCode).not.toHaveBeenCalled();
  });

  it('creates a code once the split fits', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /new code/i });

    await user.click(screen.getByRole('button', { name: /new code/i }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText(/^code/i), 'SPRING');
    const mine = within(dialog).getByLabelText(/you keep/i);
    await user.clear(mine);
    await user.type(mine, '20');
    const theirs = within(dialog).getByLabelText(/they save/i);
    await user.clear(theirs);
    await user.type(theirs, '10');

    await user.click(within(dialog).getByRole('button', { name: /create code/i }));
    await waitFor(() =>
      expect(api.createAffiliateCode).toHaveBeenCalledWith('SPRING', null, {
        affiliateCommissionPct: 20,
        customerDiscountPct: 10,
      }),
    );
  });

  it('rejects a code the backend would reject on format', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /new code/i });

    await user.click(screen.getByRole('button', { name: /new code/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^code/i), 'no spaces here');
    await user.click(within(dialog).getByRole('button', { name: /create code/i }));

    expect(
      await within(dialog).findByText(/3 to 20 letters, numbers, hyphens or underscores/i),
    ).toBeInTheDocument();
    expect(api.createAffiliateCode).not.toHaveBeenCalled();
  });
});
