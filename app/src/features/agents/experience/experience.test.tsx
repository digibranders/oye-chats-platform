import { type ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What is tested here is what broke silently before.
 *
 * The two blocking bugs this surface carried were the same mistake twice —
 * reading the chatbot from the shell's workspace switcher instead of from the
 * URL — so both get a regression test that puts a *different* chatbot in the
 * switcher and asserts the route wins. The rest covers the contract a form owes
 * its user: that unsaved work is visible and recoverable, that an invalid value
 * stops the save rather than reaching the server, that every one of the four
 * load states renders something a person can act on, and that the keyboard
 * reaches the parts a mouse does.
 */

const api = vi.hoisted(() => ({
  getBot: vi.fn(),
  updateBot: vi.fn(),
  previewChatStream: vi.fn(),
  getBotPreviewUrl: vi.fn(() => 'https://demo.test/preview'),
  getBrandTonePresets: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
  detectBrandTone: vi.fn(),
  previewBrandTone: vi.fn(),
  getSeedQuestions: vi.fn(async (): Promise<string[]> => []),
  refreshSeedQuestions: vi.fn(async (): Promise<string[]> => []),
  uploadLogo: vi.fn(),
}));

vi.mock('../../../services/api', () => api);

/**
 * The shell switcher holds chatbot **3** in every test in this file, while the
 * URL names chatbot **7**. Anything that touches 3 is the bug.
 */
vi.mock('../../../context/BotContext', () => ({
  useBotContext: () => ({
    bots: [
      { id: 3, name: 'Sales bot' },
      { id: 7, name: 'Support bot' },
    ],
    selectedBot: { id: 3, name: 'Sales bot' },
    selectBot: vi.fn(),
    refreshBots: vi.fn(async () => []),
    loading: false,
    error: null,
    isAllAgents: false,
  }),
}));

const entitlements = vi.hoisted(() => ({ live_chat: true, branding_removable: true, isFree: false }));

vi.mock('../../../hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    hasFeature: (key: string) => Boolean((entitlements as Record<string, unknown>)[key]),
    isFree: entitlements.isFree,
    loading: false,
    entitlements: {},
    error: null,
    refresh: vi.fn(),
    planSlug: 'standard',
    planName: 'Standard',
    limitFor: () => 0,
    withinLimit: () => true,
    remaining: () => 0,
  }),
}));

// The orb is a WebGL canvas, which jsdom does not have. It is the widget's own
// renderer and is exercised by the widget's tests, not by this page's.
vi.mock('../../../components/PremiumOrb', () => ({ default: () => null }));

import { AgentProvider } from '../../../context/AgentContext';
import { ExperiencePage } from './ExperiencePage';

const BOT: Record<string, unknown> = {
  id: 7,
  bot_key: 'bot-support',
  name: 'Support bot',
  website: 'https://acme.test',
  plan_slug: 'standard',
  plan_name: 'Standard',
  crawl_completed_at: '2026-08-01T10:00:00Z',
  primary_color: '#2b66bc',
  user_bubble_color: '#dbe9ff',
  avatar_type: 'mascot',
  branding_text: 'Powered by OyeChats',
  branding_url: 'https://www.oyechats.com',
  feature_flags: { show_branding: true },
  widget_messages: { welcome_greeting: 'Hello there', welcome_suggestions: ['What do you cost?'] },
  system_prompt: '',
  services: [],
  answer_links: [],
  live_chat_enabled: true,
  business_hours: null,
  lead_form_enabled: false,
  lead_form_fields: [],
};

function renderPage(path = '/chatbots/7/experience'): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        path: '/chatbots/:agentId/experience',
        element: (
          <AgentProvider>
            <ExperiencePage />
          </AgentProvider>
        ),
      },
      { path: '/chatbots', element: <p>All chatbots</p> },
      { path: '/inbox', element: <p>Inbox</p> },
      { path: '/billing', element: <p>Billing</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider> as ReactElement,
  );
}

/** Wait for the page to have loaded its record. Branding is the default tab. */
async function ready(): Promise<void> {
  await screen.findByRole('heading', { level: 1, name: 'Experience' });
  await screen.findByLabelText('Brand colour');
}

async function openTab(name: string): Promise<void> {
  await userEvent.click(screen.getByRole('tab', { name }));
  // Base UI renders only the active panel, so every assertion about a tab's
  // contents has to wait for it to actually be mounted.
  await waitFor(() =>
    expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true'),
  );
}

beforeEach(() => {
  api.getBot.mockResolvedValue({ ...BOT });
  api.updateBot.mockResolvedValue({ message: 'ok' });
  api.previewChatStream.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  entitlements.live_chat = true;
  entitlements.branding_removable = true;
  entitlements.isFree = false;
});

// ── The two blocking bugs ────────────────────────────────────────────────────

describe('the chatbot in the URL is the chatbot on the page', () => {
  it('B6: the preview streams from the route chatbot, not the shell switcher', async () => {
    renderPage();
    await ready();

    const composer = screen.getByLabelText('Ask your chatbot a question in the preview');
    await userEvent.type(composer, 'Do you ship to India?{Enter}');

    await waitFor(() => expect(api.previewChatStream).toHaveBeenCalled());
    // 7 is the URL. 3 is the switcher, and is what the console this replaces
    // would have asked.
    expect(api.previewChatStream.mock.calls[0][0]).toBe(7);
    expect(api.previewChatStream.mock.calls[0][1]).toBe('Do you ship to India?');
  });

  it('B1: business hours are written to the route chatbot, in the flat stored shape', async () => {
    renderPage();
    await ready();
    await openTab('Handoff');

    await userEvent.click(screen.getByRole('switch', { name: /Only available at set hours/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.updateBot).toHaveBeenCalled());
    const [botId, patch] = api.updateBot.mock.calls[0] as [number, Record<string, unknown>];
    // Not `bots[0]` — the workspace editor this replaces wrote to whichever
    // chatbot happened to be first, so chatbots 2..N could never have hours.
    expect(botId).toBe(7);

    const hours = patch.business_hours as Record<string, unknown>;
    expect(hours.mon).toEqual({ start: '09:00', end: '17:00' });
    expect(hours.sat).toBeNull();
    // `BusinessHours` in `bot_routes.py` sets `extra="forbid"`: the shape the
    // previous editor sent was a 422, not merely a shape the server ignored.
    expect(hours).not.toHaveProperty('enabled');
    expect(hours).not.toHaveProperty('days');
  });

  it('does not read the shell switcher anywhere in this surface', async () => {
    // The structural half of the two fixes above. Both bugs were one habit, and
    // a habit is cheaper to ban than to re-find.
    const modules = import.meta.glob('./*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const offenders = Object.entries(modules)
      .filter(([name]) => !name.endsWith('.test.ts') && !name.endsWith('.test.tsx'))
      // An import, not a mention: the modules here are allowed to explain in a
      // comment why they do not read the switcher.
      .filter(([, source]) => /from\s+['"][^'"]*context\/BotContext['"]/.test(source as string))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});

// ── The save contract ────────────────────────────────────────────────────────

describe('unsaved changes are visible and recoverable', () => {
  it('shows nothing until the draft diverges, then names which tab holds it', async () => {
    renderPage();
    await ready();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();

    await openTab('Messages');
    await userEvent.type(screen.getByLabelText(/Display name/), '!');
    expect(await screen.findByText(/Unsaved changes in Messages/)).toBeInTheDocument();
  });

  it('marks the tab that holds the unsaved work, not just the bar', async () => {
    renderPage();
    await ready();
    await openTab('Messages');
    await userEvent.type(screen.getByLabelText(/Display name/), '!');

    // The bar is at the bottom of a long column; the dot is where the user's
    // attention already is.
    expect(await screen.findByText('Messages has unsaved changes')).toBeInTheDocument();
    expect(screen.queryByText('Branding has unsaved changes')).not.toBeInTheDocument();
  });

  it('discard puts the field back and clears the bar', async () => {
    renderPage();
    await ready();
    await openTab('Messages');
    const name = screen.getByLabelText(/Display name/);
    await userEvent.type(name, '!');

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(name).toHaveValue('Support bot');
    await waitFor(() =>
      expect(screen.queryByText(/Unsaved changes/)).not.toBeInTheDocument(),
    );
  });

  it('sends only what changed, and confirms afterwards', async () => {
    renderPage();
    await ready();
    await openTab('Messages');
    await userEvent.clear(screen.getByLabelText('Greeting'));
    await userEvent.type(screen.getByLabelText('Greeting'), 'Hi!');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.updateBot).toHaveBeenCalledWith(7, {
      widget_messages: { welcome_greeting: 'Hi!' },
    }));
    expect(await screen.findByText(/Saved\. Visitors see it now\./)).toBeInTheDocument();
  });

  it('blocks the save on a field-level error instead of taking a 422', async () => {
    renderPage();
    await ready();
    await openTab('Messages');
    await userEvent.clear(screen.getByLabelText(/Display name/));

    expect(await screen.findByText(/Give your chatbot a name/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(api.updateBot).not.toHaveBeenCalled();
  });

  it('asks before leaving the page with work on it', async () => {
    // Any in-app link will do; this workspace cannot remove branding, so the
    // Branding tab carries a real one to Billing.
    entitlements.branding_removable = false;
    renderPage();
    await ready();
    const hex = screen.getByLabelText('Brand colour');
    await userEvent.clear(hex);
    await userEvent.type(hex, '#111111');
    await screen.findByText(/Unsaved changes in Branding/);

    await userEvent.click(screen.getByRole('link', { name: /Compare plans/i }));
    expect(await screen.findByRole('alertdialog', { name: /Leave without saving\?/ })).toBeInTheDocument();
    // Still here: the navigation was intercepted, not merely warned about.
    expect(screen.getByLabelText('Brand colour')).toBeInTheDocument();
  });

  it('lets the user leave once they have said so', async () => {
    entitlements.branding_removable = false;
    renderPage();
    await ready();
    const hex = screen.getByLabelText('Brand colour');
    await userEvent.clear(hex);
    await userEvent.type(hex, '#111111');
    await userEvent.click(screen.getByRole('link', { name: /Compare plans/i }));

    await userEvent.click(await screen.findByRole('button', { name: 'Discard and leave' }));
    expect(await screen.findByText('Billing')).toBeInTheDocument();
  });

  it('turns read-only rather than pretending, when the server refuses the write', async () => {
    api.updateBot.mockRejectedValue(Object.assign(new Error('You cannot manage bots.'), { status: 403 }));
    renderPage();
    await ready();
    await openTab('Messages');
    await userEvent.type(screen.getByLabelText(/Display name/), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/These settings are now read-only/)).toBeInTheDocument();
    // The work is still on screen. Blanking the form on a refusal loses it.
    expect(screen.getByLabelText(/Display name/)).toHaveValue('Support bot!');
  });
});

// ── The four states ──────────────────────────────────────────────────────────

describe('the four states', () => {
  it('loading: a skeleton shaped like what arrives', () => {
    api.getBot.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Experience' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument();
  });

  it('missing: a chatbot that is not there says so, and offers the list', async () => {
    api.getBot.mockRejectedValue(Object.assign(new Error('Bot not found.'), { status: 404 }));
    renderPage();
    expect(await screen.findByText('This chatbot does not exist')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All chatbots' })).toBeInTheDocument();
  });

  it('forbidden: a refusal is not an error, and does not offer a retry', async () => {
    api.getBot.mockRejectedValue(Object.assign(new Error('Nope'), { status: 403 }));
    renderPage();
    expect(await screen.findByText('Your seat cannot configure this chatbot')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('error: a failure explains itself and offers the way back', async () => {
    api.getBot.mockRejectedValue(Object.assign(new Error('Gateway timeout'), { status: 502 }));
    renderPage();
    expect(await screen.findByText('We could not load this chatbot')).toBeInTheDocument();

    api.getBot.mockResolvedValue({ ...BOT });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await ready();
  });

  it('warns when the workspace has a feature but this chatbot does not', async () => {
    // Billing attaches to the chatbot, so a paid workspace can hold a Free one.
    api.getBot.mockResolvedValue({ ...BOT, plan_slug: 'free', plan_name: 'Free' });
    renderPage();
    await ready();
    await openTab('Handoff');
    expect(screen.getByText('This chatbot is on the Free plan')).toBeInTheDocument();
  });

  it('plan-locked: a section the plan does not include names the plan, not the failure', async () => {
    entitlements.live_chat = false;
    renderPage();
    await ready();
    await openTab('Handoff');
    expect(screen.getByText('Live chat is on Starter and above')).toBeInTheDocument();
    // The availability schedule is not plan-gated and stays reachable.
    expect(screen.getByRole('switch', { name: /Only available at set hours/i })).toBeInTheDocument();
  });
});

// ── Keyboard ─────────────────────────────────────────────────────────────────

describe('keyboard paths', () => {
  it('walks the tab row with arrows and activates deliberately', async () => {
    renderPage();
    await ready();
    const branding = screen.getByRole('tab', { name: 'Branding' });
    branding.focus();

    await userEvent.keyboard('{ArrowRight}');
    // Manual activation: moving focus must not switch the panel, or a keyboard
    // user passing through mounts every tab on the way.
    expect(screen.getByRole('tab', { name: 'Branding' })).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Messages' })).toHaveAttribute('aria-selected', 'true'),
    );
  });

  it('reorders a starter question from the keyboard, and focus follows the row', async () => {
    api.getBot.mockResolvedValue({
      ...BOT,
      widget_messages: { ...(BOT.widget_messages as object), welcome_suggestions: ['First', 'Second'] },
    });
    renderPage();
    await ready();
    await openTab('Messages');

    const moveDown = screen.getByRole('button', { name: 'Move starter question 1 down' });
    moveDown.focus();
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByLabelText('Starter question 1')).toHaveValue('Second'));
    expect(screen.getByLabelText('Starter question 2')).toHaveValue('First');
    // The moved value is now row 2, and focus is on it — otherwise a second
    // press would move a different question.
    await waitFor(() => expect(screen.getByLabelText('Starter question 2')).toHaveFocus());
  });

  it('keeps every action reachable by name, not by icon alone', async () => {
    renderPage();
    await ready();
    await openTab('Messages');
    const list = screen.getByRole('button', { name: 'Remove starter question 1' });
    expect(list).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a question' })).toBeInTheDocument();
  });
});

// ── The preview ──────────────────────────────────────────────────────────────

describe('the preview never claims to be live when it is not', () => {
  it('is badged live while the draft matches what is stored', async () => {
    renderPage();
    await ready();
    const preview = screen.getByRole('group', { name: 'Chat widget preview' }).parentElement as HTMLElement;
    expect(within(preview.parentElement as HTMLElement).getByText('Live')).toBeInTheDocument();
  });

  it('warns that a generated reply still comes from the saved chatbot', async () => {
    renderPage();
    await ready();
    await openTab('Voice');
    await userEvent.type(screen.getByLabelText('Custom instructions'), 'Answer in French.');

    expect(await screen.findByText(/Replies still use your saved settings/)).toBeInTheDocument();
  });

  it('does not warn about a change that cannot affect a reply', async () => {
    renderPage();
    await ready();
    await openTab('Messages');
    await userEvent.type(screen.getByLabelText('Greeting'), '!');
    await waitFor(() =>
      expect(screen.queryByText(/Replies still use your saved settings/)).not.toBeInTheDocument(),
    );
  });
});

// ── Ledger items ─────────────────────────────────────────────────────────────

describe('starter questions can be regenerated and then edited', () => {
  it('asks for the cached set first, and forces a new one on the second press', async () => {
    api.getSeedQuestions.mockResolvedValue(['How much does it cost?']);
    api.refreshSeedQuestions.mockResolvedValue(['Do you offer support?']);
    renderPage();
    await ready();
    await openTab('Messages');

    await userEvent.click(screen.getByRole('button', { name: /Suggest questions/ }));
    expect(await screen.findByRole('button', { name: /How much does it cost\?/ })).toBeInTheDocument();
    expect(api.getSeedQuestions).toHaveBeenCalledWith(7);

    await userEvent.click(screen.getByRole('button', { name: /Suggest different questions/ }));
    // Without `force` the server hands back the set it cached the first time it
    // was ever asked, for the life of the chatbot.
    await waitFor(() => expect(api.refreshSeedQuestions).toHaveBeenCalledWith(7));

    await userEvent.click(await screen.findByRole('button', { name: /Do you offer support\?/ }));
    expect(screen.getByLabelText('Starter question 2')).toHaveValue('Do you offer support?');
  });
});

describe('the brand voice can be heard before it is saved', () => {
  it('samples the unsaved tone rather than streaming the saved one', async () => {
    api.previewBrandTone.mockResolvedValue({ sample: 'Sure thing — here is what that costs.' });
    renderPage();
    await ready();
    await openTab('Voice');

    await userEvent.type(screen.getByLabelText('Voice and tone'), 'Playful and brief.');
    await userEvent.click(screen.getByRole('button', { name: /Hear this voice/ }));

    await waitFor(() =>
      expect(api.previewBrandTone).toHaveBeenCalledWith(7, 'Playful and brief.'),
    );
    expect(await screen.findByText('Sure thing — here is what that costs.')).toBeInTheDocument();
    // It must not have reached for the saved-record stream to do this.
    expect(api.previewChatStream).not.toHaveBeenCalled();
  });

  it('commits a detected tone as saved, not as an unsaved edit', async () => {
    api.detectBrandTone.mockResolvedValue({ brand_tone: 'Warm and plain', brand_tone_preset: 'friendly' });
    renderPage();
    await ready();
    await openTab('Voice');

    await userEvent.click(screen.getByRole('button', { name: /Detect from my site/ }));
    await waitFor(() => expect(screen.getByLabelText('Voice and tone')).toHaveValue('Warm and plain'));
    // The endpoint writes what it detects, so reporting it as unsaved would
    // offer a Discard that cannot undo anything.
    expect(screen.queryByText(/Unsaved changes/)).not.toBeInTheDocument();
  });
});
