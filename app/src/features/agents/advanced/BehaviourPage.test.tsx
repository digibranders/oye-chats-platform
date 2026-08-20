import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BehaviourPage } from './BehaviourPage';
import { useAgent } from '../../../context/AgentContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { getBot, getClientSettings, updateBot } from '../../../services/api';
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
  getBot: vi.fn(),
  getClientSettings: vi.fn(),
  updateBot: vi.fn(),
}));

const agent: Bot = { id: 7, name: 'Support Concierge', plan_slug: 'professional' };

const SETTINGS: Record<string, unknown> = {
  relevance_threshold: 0.55,
  feature_flags: { typing_preview: true, post_chat_rating: true },
  widget_config: { greeting_delay_ms: 3000 },
  operator_timeout_seconds: 120,
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
      { path: '/chatbots/:agentId/behaviour', element: <BehaviourPage /> },
      { path: '/billing', element: <h1>Billing</h1> },
    ],
    { initialEntries: ['/chatbots/7/behaviour'] },
  );
  // The follow-up kill switch reads and writes the chatbot through TanStack
  // Query rather than through the page's draft, so the page needs a client.
  // Retries off: a test that waits out a retry schedule is a slow flaky test.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    ...render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
  };
}

async function renderSettled() {
  const result = renderPage();
  expect(await screen.findByRole('heading', { name: 'Answering scope' })).toBeInTheDocument();
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
  vi.mocked(getBot).mockResolvedValue({ ...agent, followup_sending_paused: false });
  vi.mocked(updateBot).mockResolvedValue({ message: 'ok' });
});

describe('the four states', () => {
  it('shows a skeleton while the chatbot resolves', () => {
    mountAgent(null, { loading: true });
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Behaviour' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Answering scope' })).not.toBeInTheDocument();
  });

  it('explains a missing chatbot', async () => {
    mountAgent(null);
    renderPage();
    expect(await screen.findByText('Chatbot not found')).toBeInTheDocument();
  });

  it('shows a load failure and retries it', async () => {
    vi.mocked(getClientSettings).mockRejectedValueOnce(new Error('Gateway timeout'));
    renderPage();

    expect(await screen.findByText('Gateway timeout')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Answering scope' })).toBeInTheDocument();
  });

  it('is NOT locked as a whole for a Free workspace', async () => {
    /* The Advanced tab this replaces rendered one upgrade card for the entire
       page on Free — including the answering-scope control, which works on
       every plan. */
    mountEntitlements({ isFree: true, hasFeature: () => false, planName: 'Free' });
    await renderSettled();

    expect(screen.getByRole('radiogroup', { name: 'Answering strictness' })).toBeInTheDocument();
  });

  it('locks only the operator window when the plan has no live chat', async () => {
    mountEntitlements({ hasFeature: (key) => key !== 'live_chat' });
    await renderSettled();

    expect(screen.getByText(/Live chat is not included/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Time to accept/)).not.toBeInTheDocument();
  });
});

describe('answering scope', () => {
  it('walks the three levels with the arrow keys', async () => {
    await renderSettled();

    const balanced = screen.getByRole('radio', { name: 'Balanced' });
    balanced.focus();
    await user.keyboard('{ArrowRight}');

    expect(screen.getByRole('radio', { name: 'Strict' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Declines anything not clearly covered/)).toBeInTheDocument();
  });

  it('keeps an off-preset value reachable instead of leaving nothing selected', async () => {
    /* `SegmentedControl` is a roving-tabindex radiogroup: a value matching no
       item leaves every segment at tabIndex -1 and the control unreachable from
       the keyboard. A hand-set threshold gets its own segment. */
    vi.mocked(getClientSettings).mockResolvedValue({ ...SETTINGS, relevance_threshold: 0.72 });
    await renderSettled();

    const custom = screen.getByRole('radio', { name: 'Custom (0.72)' });
    expect(custom).toHaveAttribute('aria-checked', 'true');
    expect(custom).toHaveAttribute('tabindex', '0');
  });

  it('resets to the platform default and persists the null', async () => {
    await renderSettled();

    await user.click(screen.getByRole('button', { name: 'Reset to the platform default' }));
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateBot).toHaveBeenCalled());
    const [, payload] = vi.mocked(updateBot).mock.calls[0];
    expect(payload.relevance_threshold).toBeNull();
  });
});

describe('widget behaviour', () => {
  it('says the Free plan overrides every flag, without misreporting the stored values', async () => {
    /* `get_bot_settings_public` rewrites the whole map to false for a Free
       workspace before the widget sees it. Flipping the switches here would
       misreport what is actually on the record. */
    mountEntitlements({ isFree: true, hasFeature: () => false });
    await renderSettled();

    expect(screen.getByText(/switched off for visitors on the Free plan/i)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Typing indicator' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('marks queue position as having no effect without live chat', async () => {
    mountEntitlements({ hasFeature: (key) => key !== 'live_chat' });
    await renderSettled();

    expect(screen.getByText(/no queue without live chat/i)).toBeInTheDocument();
  });

  it('saves a flipped flag', async () => {
    await renderSettled();

    await user.click(screen.getByRole('switch', { name: 'File sharing' }));
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateBot).toHaveBeenCalled());
    const [, payload] = vi.mocked(updateBot).mock.calls[0];
    expect((payload.feature_flags as Record<string, boolean>).file_sharing).toBe(true);
  });
});

describe('the operator response window', () => {
  it('refuses a value the API would reject, naming the range', async () => {
    await renderSettled();

    const field = screen.getByLabelText('Time to accept (seconds)');
    await user.clear(field);
    await user.type(field, '2');

    expect(await screen.findByText(/5 to 3600 seconds\. 2 would be rejected/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(updateBot).not.toHaveBeenCalled();
  });

  it('saves a value inside the range', async () => {
    await renderSettled();

    const field = screen.getByLabelText('Time to accept (seconds)');
    await user.clear(field);
    await user.type(field, '90');
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateBot).toHaveBeenCalled());
    expect(vi.mocked(updateBot).mock.calls[0][1].operator_timeout_seconds).toBe(90);
  });
});

describe('timing and reliability', () => {
  it('is behind a real disclosure button, not a hidden div', async () => {
    await renderSettled();

    const toggle = screen.getByRole('button', { name: /Show settings/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByLabelText(/Greeting bubble delay/)).not.toBeVisible();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText(/Greeting bubble delay/)).toBeVisible();
  });

  it('clamps a value the server would happily store and the widget could not survive', async () => {
    await renderSettled();
    await user.click(screen.getByRole('button', { name: /Show settings/ }));

    const field = screen.getByLabelText('Heartbeat, widget open (seconds)');
    await user.clear(field);
    await user.type(field, '99999');
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateBot).toHaveBeenCalled());
    const config = vi.mocked(updateBot).mock.calls[0][1].widget_config as Record<string, number>;
    expect(config.heartbeat_visible_ms).toBe(300_000);
  });
});

describe('the dirty / save contract', () => {
  it('discards back to the loaded values', async () => {
    await renderSettled();

    await user.click(screen.getByRole('radio', { name: 'Strict' }));
    await user.click(await screen.findByRole('button', { name: 'Discard' }));

    expect(screen.getByRole('radio', { name: 'Balanced' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('blocks navigation away from unsaved work', async () => {
    const { router } = await renderSettled();

    await user.click(screen.getByRole('radio', { name: 'Strict' }));
    await router.navigate('/billing');

    expect(await screen.findByRole('alertdialog')).toHaveTextContent(/Leave without saving\?/);
  });

  it('lets the user leave once they confirm', async () => {
    const { router } = await renderSettled();

    await user.click(screen.getByRole('radio', { name: 'Strict' }));
    await router.navigate('/billing');
    await user.click(await screen.findByRole('button', { name: 'Discard and leave' }));

    expect(await screen.findByRole('heading', { name: 'Billing' })).toBeInTheDocument();
  });
});

describe('capability nothing reads', () => {
  it('names each inert setting rather than omitting it', async () => {
    await renderSettled();

    expect(screen.getByRole('heading', { name: 'Not configurable yet' })).toBeInTheDocument();
    for (const title of ['Routing strategy', 'Operator disconnect grace period']) {
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    }
  });

  it('no longer claims the three settings that became reachable are blocked', async () => {
    await renderSettled();

    // Each of these is now writable and owned by a real surface. Leaving them
    // on the "not configurable" list would be the page telling the customer
    // their own product cannot do something it does.
    const blocked = screen.getByRole('heading', { name: 'Not configurable yet' }).closest('[data-card]');
    expect(blocked).not.toBeNull();
    expect(blocked?.textContent).not.toMatch(/visitor_disconnect_timeout/i);
    expect(blocked?.textContent).not.toMatch(/followup_sending_paused/i);
    expect(blocked?.textContent).not.toMatch(/Pause this chatbot/i);
  });

  it('offers the follow-up kill switch the page used to call unreachable', async () => {
    await renderSettled();

    expect(
      await screen.findByRole('switch', { name: 'Pause follow-up emails' }),
    ).toBeInTheDocument();
  });
});
