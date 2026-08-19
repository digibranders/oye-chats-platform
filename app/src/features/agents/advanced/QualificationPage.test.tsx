import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QualificationPage } from './QualificationPage';
import { useAgent } from '../../../context/AgentContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import {
  getClientSettings,
  getFrameworkPresets,
  getQualificationFunnel,
  getWebhooks,
  updateBot,
} from '../../../services/api';
import type { Bot } from '../../../types/domain';

/*
 * These two files render the whole page against jsdom, and the Qualification
 * rubric alone is around sixty controls. A single test is comfortably inside a
 * second on its own; the default five-second budget only bites when vitest runs
 * every file in this directory in parallel and the workers contend. A test that
 * fails on machine load is a flaky test, which is a defect of its own.
 */
vi.setConfig({ testTimeout: 30_000 });

vi.mock('../../../context/AgentContext', () => ({ useAgent: vi.fn() }));
vi.mock('../../../hooks/useEntitlements', () => ({ useEntitlements: vi.fn() }));
vi.mock('../../../services/api', () => ({
  getClientSettings: vi.fn(),
  getFrameworkPresets: vi.fn(),
  getQualificationFunnel: vi.fn(),
  getWebhooks: vi.fn(),
  updateBot: vi.fn(),
}));

const agent: Bot = { id: 7, name: 'Support Concierge', plan_slug: 'professional' };

const SETTINGS: Record<string, unknown> = {
  bant_enabled: true,
  qualification_framework: 'bant',
  bant_config: null,
  email_on_qualified: true,
  notification_emails: { qualified_lead: ['sales@example.test'] },
  email_verification_enabled: false,
  company_lookup_enabled: false,
};

function mountAgent(value: Bot | null, rest: Partial<ReturnType<typeof useAgent>> = {}) {
  vi.mocked(useAgent).mockReturnValue({
    agent: value,
    agentId: value ? String(value.id) : null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    ...rest,
  });
}

function mountEntitlements(overrides: Partial<ReturnType<typeof useEntitlements>> = {}) {
  vi.mocked(useEntitlements).mockReturnValue({
    entitlements: { features: {}, limits: {} } as never,
    loading: false,
    error: null,
    refresh: vi.fn(),
    isFree: false,
    planSlug: 'professional',
    planName: 'Professional',
    hasFeature: () => true,
    limitFor: () => -1,
    withinLimit: () => true,
    remaining: () => Infinity,
    ...overrides,
  });
}

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/chatbots/:agentId/qualification', element: <QualificationPage /> },
      { path: '/leads', element: <h1>Leads</h1> },
    ],
    { initialEntries: ['/chatbots/7/qualification'] },
  );
  return { ...render(<RouterProvider router={router} />), router };
}

/** The page is settled once the scoring model has rendered. */
async function renderSettled() {
  const result = renderPage();
  expect(await screen.findByRole('heading', { name: 'Scoring dimensions' })).toBeInTheDocument();
  return result;
}

/**
 * `delay: null` — the default inserts a real timer gap between keystrokes, and
 * these two pages are long forms, so typing three characters into six fields
 * across a suite is most of its runtime. It made the suite time out under
 * parallel load, which is a flaky test, which is a defect.
 */
let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  vi.clearAllMocks();
  user = userEvent.setup({ delay: null });
  mountAgent(agent);
  mountEntitlements();
  vi.mocked(getClientSettings).mockResolvedValue(SETTINGS);
  vi.mocked(getFrameworkPresets).mockResolvedValue({});
  vi.mocked(getWebhooks).mockResolvedValue([]);
  vi.mocked(getQualificationFunnel).mockResolvedValue({ funnel: [] });
  vi.mocked(updateBot).mockResolvedValue({ message: 'ok' });
});

describe('the four states', () => {
  it('shows a skeleton while the chatbot is still resolving', () => {
    mountAgent(null, { loading: true });
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Qualification' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Scoring dimensions' })).not.toBeInTheDocument();
  });

  it('explains a chatbot that could not be found, and offers a retry', async () => {
    const refresh = vi.fn();
    mountAgent(null, { refresh });
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalled();
  });

  it('shows the load failure, and retries the fetch', async () => {
    vi.mocked(getClientSettings).mockRejectedValueOnce(new Error('Network unreachable'));
    renderPage();

    expect(await screen.findByText('Network unreachable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'Scoring dimensions' })).toBeInTheDocument();
  });

  it('locks the page for a plan without lead scoring, and names what is behind it', () => {
    mountEntitlements({ isFree: true, hasFeature: () => false, planName: 'Free' });
    renderPage();

    expect(screen.getByText(/not included on your plan/i)).toBeInTheDocument();
    // A lock with nothing behind it asks people to buy something unseen.
    expect(screen.getByText(/What you would configure/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Scoring dimensions' })).not.toBeInTheDocument();
  });

  it('shows an empty funnel rather than an empty chart', async () => {
    await renderSettled();
    expect(await screen.findByText('No conversations in this period')).toBeInTheDocument();
  });
});

describe('the framework picker', () => {
  it('offers only the two frameworks the API will accept', async () => {
    await renderSettled();
    const select = screen.getByLabelText('Framework');
    const options = within(select).getAllByRole('option').map((option) => option.textContent);

    // CHAMP, GPCTBA/CI and "Custom" were offered before and 422 on save.
    expect(options).toEqual(['BANT', 'MEDDIC']);
  });
});

describe('the dirty / save contract', () => {
  it('stays quiet until something is edited', async () => {
    await renderSettled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('shows the bar on an edit, saves the rubric, and confirms', async () => {
    await renderSettled();

    const sql = screen.getByLabelText('Sales qualified at');
    await user.clear(sql);
    await user.type(sql, '85');

    expect(await screen.findByText(/unsaved changes/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateBot).toHaveBeenCalledTimes(1));
    const [, payload] = vi.mocked(updateBot).mock.calls[0];
    expect((payload.bant_config as Record<string, Record<string, number>>).thresholds.sql).toBe(85);
    // The enrichment switches did not change, so their PATCH is not sent.
    expect(payload).not.toHaveProperty('company_lookup_enabled');

    expect(await screen.findByText('All changes saved.')).toBeInTheDocument();
  });

  it('sends the enrichment toggles in their own PATCH, without the rubric', async () => {
    await renderSettled();

    await user.click(screen.getByRole('switch', { name: /Company lookup/i }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateBot).toHaveBeenCalledTimes(1));
    const [, payload] = vi.mocked(updateBot).mock.calls[0];
    expect(payload).toEqual({ email_verification_enabled: false, company_lookup_enabled: true });
  });

  it('discards back to the loaded values', async () => {
    await renderSettled();

    const sql = screen.getByLabelText('Sales qualified at');
    await user.clear(sql);
    await user.type(sql, '85');
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }));

    await waitFor(() => expect(sql).toHaveValue(75));
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('keeps the bar up and explains a failed save', async () => {
    vi.mocked(updateBot).mockRejectedValueOnce(new Error('The server refused that config.'));
    await renderSettled();

    const sql = screen.getByLabelText('Sales qualified at');
    await user.clear(sql);
    await user.type(sql, '85');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('The server refused that config.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('blocks in-app navigation while there is unsaved work', async () => {
    const { router } = await renderSettled();

    const sql = screen.getByLabelText('Sales qualified at');
    await user.clear(sql);
    await user.type(sql, '85');

    await router.navigate('/leads');

    expect(await screen.findByRole('alertdialog')).toHaveTextContent(/Leave without saving\?/);
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Sales qualified at')).toHaveValue(85);
  });
});

describe('validation refuses a set that cannot score', () => {
  it('names the tier made unreachable by out-of-order thresholds', async () => {
    await renderSettled();

    const sql = screen.getByLabelText('Sales qualified at');
    await user.clear(sql);
    await user.type(sql, '40');

    expect(await screen.findByText(/above sales-accepted \(55\)/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(updateBot).not.toHaveBeenCalled();
  });

  it('refuses a model with every dimension switched off', async () => {
    await renderSettled();

    for (const name of ['Need', 'Timeline', 'Authority', 'Budget']) {
      await user.click(screen.getByRole('switch', { name: `Score ${name}` }));
    }

    expect(await screen.findByText(/at least one dimension switched on/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('accepts weights that do not total 100, because the server normalises them', async () => {
    await renderSettled();

    const weight = screen.getAllByLabelText('Weight')[0];
    await user.clear(weight);
    await user.type(weight, '5');

    expect(await screen.findByRole('button', { name: 'Save changes' })).toBeEnabled();
    // …and the running total is shown so the reader can see what they did.
    expect(screen.getByText(/across/)).toBeInTheDocument();
  });

  it('rebalances to exactly 100 on request', async () => {
    await renderSettled();

    const weight = screen.getAllByLabelText('Weight')[0];
    await user.clear(weight);
    await user.type(weight, '5');
    await user.click(await screen.findByRole('button', { name: 'Balance to 100' }));

    await waitFor(() => expect(screen.getByText('100')).toBeInTheDocument());
  });
});

describe('what fires at each tier', () => {
  it('says plainly that only sales-qualified sends anything', async () => {
    await renderSettled();

    const heading = await screen.findByRole('heading', { name: 'What happens at each tier' });
    const card = heading.closest('section') as HTMLElement;
    expect(within(card).getAllByText(/Only sales-qualified notifies anyone/i)).toHaveLength(2);
  });

  it('names the real recipients when the email will fire', async () => {
    await renderSettled();
    expect(await screen.findByText(/sales@example.test/)).toBeInTheDocument();
  });

  it('warns when nothing at all is listening', async () => {
    vi.mocked(getClientSettings).mockResolvedValue({ ...SETTINGS, notification_emails: {} });
    await renderSettled();

    expect(await screen.findByText('Nothing is listening')).toBeInTheDocument();
  });

  it('reports a webhook that is registered but not subscribed', async () => {
    vi.mocked(getWebhooks).mockResolvedValue([
      { id: 1, url: 'https://crm.example.test/hook', events: ['lead_captured'], is_active: true },
    ]);
    await renderSettled();

    expect(await screen.findByText(/add this event to one of them/i)).toBeInTheDocument();
  });

  it('offers its own retry without touching the page draft', async () => {
    vi.mocked(getClientSettings)
      .mockResolvedValueOnce(SETTINGS)
      .mockRejectedValueOnce(new Error('Webhook check failed'))
      .mockResolvedValue(SETTINGS);
    await renderSettled();

    expect(await screen.findByText('Webhook check failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/sales@example.test/)).toBeInTheDocument();
  });
});

describe('the master switch', () => {
  it('makes the whole rubric inert when scoring is off', async () => {
    vi.mocked(getClientSettings).mockResolvedValue({ ...SETTINGS, bant_enabled: false });
    await renderSettled();

    expect(screen.getByText(/no qualified-lead email or webhook can fire/i)).toBeInTheDocument();
    // Disabled, not `inert`: the rubric stays readable — including to a screen
    // reader — but cannot be edited. Before this, a tab reached the framework
    // picker of a chatbot whose scoring was off, and changing it PATCHed the
    // rubric anyway.
    expect(screen.getByLabelText('Framework')).toBeDisabled();
    expect(screen.getByLabelText('Sales qualified at')).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Score Need' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});

describe('keyboard', () => {
  it('reaches and flips a dimension switch with the keyboard alone', async () => {
    await renderSettled();

    const toggle = screen.getByRole('switch', { name: 'Score Need' });
    toggle.focus();
    expect(toggle).toHaveFocus();

    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('expands a dimension from the keyboard and exposes its answers', async () => {
    await renderSettled();

    const expand = screen.getByRole('button', { name: 'Expand Need' });
    expand.focus();
    await user.keyboard('{Enter}');

    expect(expand).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Answer 1 for Need')).toBeInTheDocument();
  });
});
