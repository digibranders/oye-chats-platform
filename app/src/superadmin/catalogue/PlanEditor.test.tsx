import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanEditor } from './PlanEditor';
import { UNLIMITED } from './plan-model';
import type { Plan } from './types';

const httpClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../services/api', () => ({ httpClient }));

// The editor renders roughly sixty controls and every keystroke re-renders all
// of them. On its own that is fast; sharing four workers with the rest of the
// suite it can pass the 5s default, so this file buys headroom rather than
// being intermittently red.
vi.setConfig({ testTimeout: 30_000 });

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 3,
    name: 'Standard',
    slug: 'standard',
    description: 'The lead machine.',
    pricing_model: 'per_operator',
    currency: 'INR',
    monthly_price_cents: 119900,
    annual_price_cents: 1150800,
    monthly_price_usd_cents: 1599,
    annual_price_usd_cents: 15588,
    annual_discount_percent: 20,
    trial_days: 7,
    limits: {
      credits: 2500,
      bots: 1,
      operators: 2,
      leads: UNLIMITED,
      page_scraping: 2000,
      documents: UNLIMITED,
      knowledge_characters: 500000,
      chat_history_days: 90,
      max_crawl_depth: 4,
      max_crawl_pages: UNLIMITED,
      max_crawl_js_pages: 150,
      max_crawl_concurrency: 4,
    },
    features: { live_chat: true, bant: true, integrations: 'all' },
    marketing: { tagline: 'The lead machine.' },
    overage_rate_cents: 0,
    credits_per_month: 2500,
    included_operator_seats: 2,
    extra_seat_price_cents: 44900,
    extra_seat_price_usd_cents: 500,
    is_active: true,
    is_default: false,
    sort_order: 3,
    razorpay_plan_id_monthly: 'plan_m',
    razorpay_plan_id_annual: 'plan_a',
    active_subscriptions: 412,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function renderEditor(target: Plan | null = plan(), onSaved = vi.fn()) {
  return render(
    <MemoryRouter>
      <PlanEditor
        open
        plan={target}
        plans={[plan()]}
        onOpenChange={vi.fn()}
        onSaved={onSaved}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * The gate in front of the highest-leverage form in the product.
 *
 * A plan save reaches every live subscription on the tier within a minute. These
 * pin the three things that stop that being a single misplaced click: nothing is
 * sent until a confirmation names the blast radius, a save that changes nothing
 * sends nothing, and the unlimited sentinel is a switch rather than a number.
 */
describe('PlanEditor', () => {
  it('says how many live subscriptions the row governs', () => {
    renderEditor();
    expect(screen.getByText(/412 live subscriptions/)).toBeInTheDocument();
  });

  it('loads an unlimited limit as a switch, with no -1 anywhere in the form', () => {
    renderEditor();
    const documents = screen.getByLabelText('Documents') as HTMLInputElement;
    expect(documents.value).toBe('');
    expect(documents).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Unlimited — documents' })).toBeChecked();
    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    expect(inputs.every((input) => input.value !== '-1')).toBe(true);
  });

  it('sends nothing at all when nothing was edited', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole('button', { name: 'Review and save' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(httpClient.put).not.toHaveBeenCalled();
  });

  it('does not save until the confirmation is accepted, and shows what changes', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    httpClient.put.mockResolvedValue({ data: { message: 'Plan updated.', warnings: [] } });
    renderEditor(plan(), onSaved);

    const trial = screen.getByLabelText('Trial days');
    await user.clear(trial);
    await user.type(trial, '14');
    await user.click(screen.getByRole('button', { name: 'Review and save' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Trial days');
    expect(dialog).toHaveTextContent('412');
    expect(httpClient.put).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save plan' }));
    await waitFor(() =>
      expect(httpClient.put).toHaveBeenCalledWith('/superadmin/plans/3', { trial_days: 14 }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it('refuses to open the confirmation while a field is invalid', async () => {
    const user = userEvent.setup();
    renderEditor();

    const seats = screen.getByLabelText('Included operator seats');
    await user.clear(seats);
    await user.type(seats, '0');
    await user.click(screen.getByRole('button', { name: 'Review and save' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await screen.findByText('This plan cannot be saved yet')).toBeInTheDocument();
    expect(httpClient.put).not.toHaveBeenCalled();
  });

  it('warns before saving that a price edit mints a new gateway plan', async () => {
    const user = userEvent.setup();
    renderEditor();
    const price = screen.getByLabelText('Monthly price (INR paise)');
    await user.clear(price);
    await user.type(price, '129900');
    expect(await screen.findByText('Worth knowing before you save')).toBeInTheDocument();
    expect(screen.getAllByText(/Razorpay plans are immutable/).length).toBeGreaterThan(1);
  });

  it('keeps the drawer open and shows the server advisories after a save that carried them', async () => {
    const user = userEvent.setup();
    httpClient.put.mockResolvedValue({
      data: { message: 'Plan updated.', warnings: ['Plan is listed but has no INR Razorpay plan id.'] },
    });
    renderEditor();

    const trial = screen.getByLabelText('Trial days');
    await user.clear(trial);
    await user.type(trial, '14');
    await user.click(screen.getByRole('button', { name: 'Review and save' }));
    await user.click(await screen.findByRole('button', { name: 'Save plan' }));

    expect(await screen.findByText('Saved, with warnings')).toBeInTheDocument();
    expect(
      screen.getByText('Plan is listed but has no INR Razorpay plan id.'),
    ).toBeInTheDocument();
  });

  it('reports a refused save without closing the form', async () => {
    const user = userEvent.setup();
    httpClient.put.mockRejectedValue({
      response: { status: 422, data: { detail: 'annual_discount_percent is derived.' } },
    });
    renderEditor();

    const trial = screen.getByLabelText('Trial days');
    await user.clear(trial);
    await user.type(trial, '14');
    await user.click(screen.getByRole('button', { name: 'Review and save' }));
    await user.click(await screen.findByRole('button', { name: 'Save plan' }));

    expect(await screen.findByText('annual_discount_percent is derived.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review and save' })).toBeInTheDocument();
  });

  it('never offers to type the extra seat price, which the API fixes', () => {
    renderEditor();
    expect(screen.queryByLabelText(/Extra seat price/i)).not.toBeInTheDocument();
    expect(screen.getByText('Extra seat price')).toBeInTheDocument();
  });

  it('creates with a slug field, and locks it once the plan exists', () => {
    const { unmount } = renderEditor(null);
    expect(screen.getByLabelText(/Slug/)).toBeEnabled();
    unmount();
    renderEditor(plan());
    expect(screen.getByLabelText('Slug')).toBeDisabled();
  });
});
