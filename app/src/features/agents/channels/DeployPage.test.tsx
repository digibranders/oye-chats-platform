import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeployPage } from './DeployPage';
import { useDeployData } from './useDeployData';
import { installStatus } from './deployModel';
import { useAgent } from '../../../context/AgentContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { getClientSettings, updateBot } from '../../../services/api';
import type { Bot } from '../../../types/domain';

/**
 * Access, on the page that owns it.
 *
 * The controls themselves are covered by `access.test.tsx`. What is covered here
 * is the contract they gained by moving: one draft, one save bar, one PATCH sent
 * only when the slice moved, and a confirmation in front of the save that can
 * take the customer's own widget offline.
 *
 * `useDeployData` is mocked rather than driven. It owns a polled query, a
 * localStorage claim and an activation event, none of which this file is about.
 */
vi.setConfig({ testTimeout: 30_000 });

vi.mock('./useDeployData', () => ({ useDeployData: vi.fn() }));
vi.mock('../../../context/AgentContext', () => ({ useAgent: vi.fn() }));
vi.mock('../../../hooks/useEntitlements', () => ({ useEntitlements: vi.fn() }));
vi.mock('../../../services/api', () => ({
  getBotDemoUrl: (key: string) => `https://api.test/demo/${key}`,
  getClientSettings: vi.fn(),
  updateBot: vi.fn(),
  recordActivationEvent: vi.fn().mockResolvedValue({}),
  sendInstallInvite: vi.fn().mockResolvedValue({}),
  recaptureDemoScreenshot: vi.fn().mockResolvedValue({}),
  trackDemoShareClick: vi.fn().mockResolvedValue({}),
}));

const agent: Bot = {
  id: 7,
  name: 'Support Concierge',
  plan_slug: 'professional',
  website: 'https://www.acme.com',
};

const SETTINGS: Record<string, unknown> = {
  allowed_domains: [],
  domain_check_enabled: false,
  session_share_domain: '',
};

function mountDeploy(botOverrides: Record<string, unknown> = {}) {
  const retry = vi.fn();
  vi.mocked(useDeployData).mockReturnValue({
    agentId: 7,
    bot: {
      id: 7,
      name: 'Support Concierge',
      bot_key: 'bot-11a026a4b8b3',
      website: 'https://www.acme.com',
      ...botOverrides,
    },
    loading: false,
    failure: null,
    retry,
    env: 'production',
    apiBaseUrl: 'https://api.test',
    status: installStatus({ installedAt: null, claimed: false, checking: false }),
    verifiedNow: false,
    checking: false,
    startVerifying: vi.fn(),
    stopVerifying: vi.fn(),
    save: vi.fn(),
    saving: false,
    domains: [],
    domainsLoading: false,
    domainsChecking: false,
    domainsCheckedAt: null,
    checkDomains: vi.fn(),
    domainsCheckError: null,
  } as unknown as ReturnType<typeof useDeployData>);
  return { retry };
}

function mountAgent(value: Bot | null = agent) {
  vi.mocked(useAgent).mockReturnValue({
    agent: value,
    agentId: value ? String(value.id) : null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  } as unknown as ReturnType<typeof useAgent>);
}

function mountEntitlements() {
  vi.mocked(useEntitlements).mockReturnValue({
    entitlements: { features: {}, limits: {} },
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
  } as unknown as ReturnType<typeof useEntitlements>);
}

const user = userEvent.setup();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getClientSettings).mockResolvedValue(SETTINGS);
  vi.mocked(updateBot).mockResolvedValue({} as never);
  mountAgent();
  mountEntitlements();
  mountDeploy();
});

async function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/chatbots/:agentId/deploy', element: <DeployPage /> },
      { path: '/chatbots', element: <h1>Chatbots</h1> },
    ],
    { initialEntries: ['/chatbots/7/deploy'] },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  // The access slice is a second request; nothing below exists until it lands.
  await screen.findByRole('heading', { name: 'Access' });
  return result;
}

describe('access, on Deploy', () => {
  it('edits the allow-list under the page’s own draft and save bar', async () => {
    // The chatbot has no website here, so the lock-out guard has nothing to
    // compare against and the save goes straight through. That guard has its
    // own test below.
    mountAgent({ ...agent, website: undefined });
    mountDeploy({ website: null });
    vi.mocked(getClientSettings).mockResolvedValue({
      ...SETTINGS,
      allowed_domains: ['acme.com'],
      domain_check_enabled: true,
    });
    await renderPage();

    // No save button of its own. The three that used to live on this page are
    // gone, and this is the page's single bar.
    expect(screen.queryByRole('button', { name: 'Save domains' })).toBeNull();

    await user.type(screen.getByRole('textbox', { name: 'Domains' }), 'shop.acme.com{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateBot).toHaveBeenCalled());
    const [, body] = vi.mocked(updateBot).mock.calls[0];
    expect(body).toMatchObject({
      allowed_domains: ['acme.com', 'shop.acme.com'],
      domain_check_enabled: true,
    });
  });

  it('does not rewrite an allow-list nobody touched', async () => {
    vi.mocked(getClientSettings).mockResolvedValue({
      ...SETTINGS,
      allowed_domains: ['acme.com', '*.acme.com'],
      domain_check_enabled: true,
    });
    await renderPage();

    // Nothing edited, so there is no save bar at all and the security control is
    // never written back. The saved list is on screen, so a reader can still
    // check what is being enforced without arming a save.
    expect(screen.getByRole('button', { name: 'Remove acme.com' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(updateBot).not.toHaveBeenCalled();
  });

  it('confirms before saving a list that would block the customer’s own website', async () => {
    // `_enforce_bot_origin` fails open on an empty list, so the guard only ever
    // fires once enforcement is on AND the list has an entry that misses the
    // customer's own host — `www.acme.com` against a bare `acme.com`.
    vi.mocked(getClientSettings).mockResolvedValue({
      ...SETTINGS,
      allowed_domains: ['acme.com'],
      domain_check_enabled: false,
    });
    await renderPage();

    await user.click(screen.getByRole('checkbox', { name: /Only allow the domains/i }));
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/will block your own website/i);
    // Nothing is written until the customer accepts the consequence.
    expect(updateBot).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(updateBot).toHaveBeenCalled());
  });

  it('refuses a pinned parent the cookie API cannot express, and says why', async () => {
    await renderPage();

    await user.type(screen.getByRole('textbox', { name: 'Pin a parent domain' }), '*.acme.com');

    expect(await screen.findByText(/A wildcard will not work here/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(updateBot).not.toHaveBeenCalled();
  });

  it('re-reads the chatbot after a save, so the status rail stops showing the old list', async () => {
    mountAgent({ ...agent, website: undefined });
    const { retry } = mountDeploy({ website: null });
    await renderPage();

    await user.type(screen.getByRole('textbox', { name: 'Domains' }), 'acme.com{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateBot).toHaveBeenCalled());
    // Without this the "Allowed domains" count beside the snippet would keep
    // reporting the list that was enforced before the save.
    await waitFor(() => expect(retry).toHaveBeenCalled());
  });
});
