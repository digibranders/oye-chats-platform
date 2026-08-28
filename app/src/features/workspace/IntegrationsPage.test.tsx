import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Integrations — the three ways out of the product.
 *
 * What is pinned: deleting an endpoint confirms and says what stops working
 * downstream, the signing secret is revealed once at creation and is copyable
 * there, the email form obeys the same dirty/save contract as the rest of
 * settings, and a plan boundary is an upgrade path rather than an error.
 */

const api = vi.hoisted(() => ({
  getWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  updateWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  testWebhook: vi.fn(),
  getWebhookDeliveries: vi.fn(),
  updateBot: vi.fn(),
}));
vi.mock('../../services/api', () => api);

const bots = vi.hoisted(() => ({
  bots: [{ id: 1, name: 'Acme Support' }] as Record<string, unknown>[],
  selectedBot: { id: 1, name: 'Acme Support' } as Record<string, unknown> | null,
  loading: false,
  error: null as { message: string } | null,
  refreshBots: vi.fn(),
}));
vi.mock('../../context/BotContext', () => ({ useBotContext: () => bots }));

const entitlements = vi.hoisted(() => ({
  hasFeature: ((_key: string) => true) as (key: string) => boolean,
  entitlements: { features: { integrations: 'all' as 'all' | 'reply_to_only' } },
}));
vi.mock('../../hooks/useEntitlements', () => ({ useEntitlements: () => entitlements }));

const { IntegrationsPage } = await import('./IntegrationsPage');

// A menu, a dialog and a mutation sit comfortably inside the default 5s budget
// in isolation, and comfortably outside it when the whole suite runs in
// parallel on a loaded machine. This is a statement about the runner, not about
// what is being asserted — the assertions themselves all settle in milliseconds.
vi.setConfig({ testTimeout: 20_000 });

function renderPage(entry = '/settings/integrations') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/settings/integrations" element={<IntegrationsPage />} />
          <Route path="/billing" element={<p>Billing</p>} />
          <Route path="/welcome" element={<p>First run</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  bots.bots = [{ id: 1, name: 'Acme Support' }];
  bots.selectedBot = { id: 1, name: 'Acme Support' };
  bots.loading = false;
  bots.error = null;
  entitlements.hasFeature = () => true;
  entitlements.entitlements = { features: { integrations: 'all' } };
  api.getWebhooks.mockResolvedValue([
    { id: 4, url: 'https://hooks.example.com/x', events: ['tier_transition'], is_active: true },
  ]);
  api.createWebhook.mockResolvedValue({ id: 5, secret: 'whsec_abc123', url: '', events: [] });
  api.deleteWebhook.mockResolvedValue({});
  api.updateBot.mockResolvedValue({ message: 'ok' });
});

describe('IntegrationsPage — the four states', () => {
  it('shows a loading placeholder while the chatbots resolve', () => {
    bots.loading = true;
    renderPage();
    expect(document.querySelector('[aria-busy]')).not.toBeNull();
  });

  it('reports a failure to load the chatbots, with a retry', async () => {
    bots.error = { message: 'network is down' };
    renderPage();
    expect(await screen.findByText('We could not load your chatbots')).toBeInTheDocument();
  });

  it('explains the empty case rather than showing three empty tabs', async () => {
    bots.bots = [];
    bots.selectedBot = null;
    renderPage();
    expect(await screen.findByText('No chatbot yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /create a chatbot/i })).toBeInTheDocument();
  });

  it('answers a plan boundary with what the feature is for', async () => {
    entitlements.hasFeature = (key: string) => key !== 'webhooks';
    renderPage('/settings/integrations?tab=webhooks');
    expect(await screen.findByText('Webhooks are not included on your plan')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /see plans/i })).toBeInTheDocument();
    expect(api.getWebhooks).not.toHaveBeenCalled();
  });

  it('lands on a tab the customer can use when webhooks are locked', async () => {
    entitlements.hasFeature = (key: string) => key !== 'webhooks';
    renderPage();
    expect(await screen.findByText('Addresses')).toBeInTheDocument();
  });
});

describe('IntegrationsPage — webhooks', () => {
  it('confirms before deleting an endpoint, and names what breaks downstream', async () => {
    const user = userEvent.setup();
    renderPage('/settings/integrations?tab=webhooks');
    await screen.findByText('https://hooks.example.com/x');

    await user.click(screen.getByRole('button', { name: /actions for https:\/\/hooks/i }));
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/stops working, silently/i)).toBeInTheDocument();
    expect(api.deleteWebhook).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /delete endpoint/i }));
    await waitFor(() => expect(api.deleteWebhook).toHaveBeenCalledWith(4));
  });

  it('reveals the signing secret exactly once, where it can be copied', async () => {
    const user = userEvent.setup();
    renderPage('/settings/integrations?tab=webhooks');
    await screen.findByText('https://hooks.example.com/x');

    await user.click(screen.getByRole('button', { name: /add endpoint/i }));
    const dialog = await screen.findByRole('dialog');
    // Pasted rather than typed: `user.type` costs a render per character, and a
    // 29-character URL is enough to push this test past the default timeout on
    // a loaded machine.
    await user.click(within(dialog).getByLabelText(/endpoint url/i));
    await user.paste('https://hooks.example.com/new');
    await user.click(within(dialog).getByRole('button', { name: /add endpoint/i }));

    expect(await screen.findByText('whsec_abc123')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy signing secret/i })).toBeInTheDocument();
  });

  it('will not register an endpoint we cannot reach', async () => {
    const user = userEvent.setup();
    renderPage('/settings/integrations?tab=webhooks');
    await screen.findByText('https://hooks.example.com/x');

    await user.click(screen.getByRole('button', { name: /add endpoint/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText(/endpoint url/i));
    await user.paste('https://localhost:3000/hook');
    await user.click(within(dialog).getByRole('button', { name: /add endpoint/i }));

    expect(await within(dialog).findByText(/only exists on your own machine/i)).toBeInTheDocument();
    expect(api.createWebhook).not.toHaveBeenCalled();
  });

  it('will not register an endpoint subscribed to nothing', async () => {
    const user = userEvent.setup();
    renderPage('/settings/integrations?tab=webhooks');
    await screen.findByText('https://hooks.example.com/x');

    await user.click(screen.getByRole('button', { name: /add endpoint/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText(/endpoint url/i));
    await user.paste('https://ok.example.com/hook');
    await user.click(within(dialog).getByRole('checkbox', { name: /lead qualified/i }));
    await user.click(within(dialog).getByRole('checkbox', { name: /lead captured/i }));
    await user.click(within(dialog).getByRole('button', { name: /add endpoint/i }));

    expect(
      await within(dialog).findByText(/this endpoint will never be called/i),
    ).toBeInTheDocument();
    expect(api.createWebhook).not.toHaveBeenCalled();
  });
});

describe('IntegrationsPage — email routing', () => {
  it('obeys the same dirty and discard contract as the rest of settings', async () => {
    const user = userEvent.setup();
    renderPage('/settings/integrations?tab=email');
    await screen.findByText('Addresses');

    expect(screen.getAllByText('Everything here is saved.')[0]).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: /a lead qualifies/i }));
    expect(screen.getAllByText('You have unsaved changes.')[0]).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /discard/i })[0]);
    expect(screen.getAllByText('Everything here is saved.')[0]).toBeInTheDocument();
    expect(api.updateBot).not.toHaveBeenCalled();
  });

  it('does not persist an empty per-event override as "send to nobody"', async () => {
    const user = userEvent.setup();
    renderPage('/settings/integrations?tab=email');
    await screen.findByText('Addresses');

    await user.click(screen.getByRole('switch', { name: /a lead qualifies/i }));
    await user.click(screen.getAllByRole('button', { name: /save changes/i })[0]);

    await waitFor(() => expect(api.updateBot).toHaveBeenCalled());
    const [, patch] = api.updateBot.mock.calls[0] as [number, Record<string, unknown>];
    expect(patch.notification_emails).toEqual({ default: [] });
    expect(patch.email_on_qualified).toBe(false);
  });

  it('tells a restricted plan what it can and cannot route', async () => {
    entitlements.entitlements = { features: { integrations: 'reply_to_only' } };
    renderPage('/settings/integrations?tab=email');
    expect(await screen.findByText('Recipient routing is not on your plan')).toBeInTheDocument();
    // The reply-to field is the part that still works, so it stays enabled.
    expect(screen.getByLabelText(/reply-to address/i)).toBeEnabled();
  });
});
