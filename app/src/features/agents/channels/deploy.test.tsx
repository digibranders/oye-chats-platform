import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallStatusCard } from './InstallStatusCard';
import { SnippetSection } from './SnippetSection';
import { PlatformGuide } from './PlatformGuide';
import { installStatus, widgetHeartbeat } from './deployModel';
import type { DomainInstall } from './installDomainsModel';
import { recordActivationEvent, sendInstallInvite } from '../../../services/api';
import { DEFAULT_PLATFORM_ID, platforms } from '../../../data/platformIntegrations';

vi.mock('../../../services/api', () => ({
  recordActivationEvent: vi.fn(),
  sendInstallInvite: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(recordActivationEvent).mockReset();
  vi.mocked(sendInstallInvite).mockReset();
});

/**
 * What is covered here is what a unit test of the model cannot reach: that the
 * install state is a word and not only a colour, that every control can be
 * driven from the keyboard, and that each of the four states a surface owes its
 * user actually renders one.
 *
 * The allow-list and session-continuity editors are on this page, under its
 * single draft: the controls are covered by `access.test.tsx` and the save
 * contract by `DeployPage.test.tsx`. The in-widget credit line merged into
 * Experience ▸ Branding, which already owned its on/off switch.
 */

const BOT_KEY = 'bot-11a026a4b8b3';

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

/* ------------------------------------------------------------ install card */

describe('InstallStatusCard', () => {
  const base = {
    installedAt: null,
    heartbeat: widgetHeartbeat({ installedAt: null, lastSeenAt: null, lastOrigin: null }),
    website: 'https://acme.com',
    domains: [] as string[],
    accessHref: '#access',
    verifiedNow: false,
    checking: false,
    onStartVerifying: vi.fn(),
    onStopVerifying: vi.fn(),
    onTroubleshoot: vi.fn(),
    installs: [] as DomainInstall[],
    domainsLoading: false,
    domainsChecking: false,
    domainsCheckedAt: null,
    onCheckDomains: vi.fn(),
    domainsCheckError: null,
  };

  it('says "waiting", not "error", before anyone has installed anything', () => {
    renderWithRouter(
      <InstallStatusCard
        {...base}
        status={installStatus({ installedAt: null, claimed: false, checking: false })}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Waiting to be installed' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers the claim only while nothing has been claimed', async () => {
    const onStartVerifying = vi.fn();
    renderWithRouter(
      <InstallStatusCard
        {...base}
        onStartVerifying={onStartVerifying}
        status={installStatus({ installedAt: null, claimed: false, checking: false })}
      />,
    );
    const button = screen.getByRole('button', { name: /I have added it/i });
    // Keyboard, not a click: this is the single most important control on the
    // page and it has to be reachable without a mouse.
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(onStartVerifying).toHaveBeenCalledTimes(1);
  });

  it('shows a running search with a way out of it, never a blocking gate', async () => {
    const onStopVerifying = vi.fn();
    renderWithRouter(
      <InstallStatusCard
        {...base}
        checking
        onStopVerifying={onStopVerifying}
        status={installStatus({ installedAt: null, claimed: true, checking: true })}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Looking for your widget' })).toBeInTheDocument();
    // Queried without a name: `Progress` puts its `aria-label` on the track,
    // not on the element carrying `role="progressbar"`. Reported as a `src/ui`
    // defect rather than worked around with a wrapper here.
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Not yet/i }));
    expect(onStopVerifying).toHaveBeenCalledTimes(1);
  });

  it('turns the claim into a real problem, with somewhere to go', async () => {
    const onTroubleshoot = vi.fn();
    renderWithRouter(
      <InstallStatusCard
        {...base}
        onTroubleshoot={onTroubleshoot}
        status={installStatus({ installedAt: null, claimed: true, checking: false })}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Not detected yet' })).toBeInTheDocument();
    // The checklist is a tab on the same page now, not an anchor two thousand
    // pixels further down it.
    await userEvent.click(screen.getByRole('button', { name: 'What to check' }));
    expect(onTroubleshoot).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Check again/i })).toBeInTheDocument();
  });

  it('keeps the first sighting and the heartbeat as two separate facts', () => {
    renderWithRouter(
      <InstallStatusCard
        {...base}
        installedAt="2026-08-01T09:00:00.000Z"
        heartbeat={widgetHeartbeat({
          installedAt: '2026-08-01T09:00:00.000Z',
          lastSeenAt: '2026-08-19T11:30:00.000Z',
          lastOrigin: 'www.acme.com',
        })}
        status={installStatus({ installedAt: '2026-08-01T09:00:00.000Z', claimed: false, checking: false })}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Live on your website' })).toBeInTheDocument();
    // Label → value, not stacked paragraphs. Three now, not four: `Loaded
    // from` moved out into the per-domain inventory, which says the same thing
    // for every domain instead of only for whichever called most recently.
    expect(screen.getAllByRole('term')).toHaveLength(3);
    expect(screen.getByText('First seen')).toBeInTheDocument();
    expect(screen.getByText('Last seen')).toBeInTheDocument();
  });

  it('drops the green light once the heartbeat has been quiet for a week', async () => {
    const onTroubleshoot = vi.fn();
    renderWithRouter(
      <InstallStatusCard
        {...base}
        onTroubleshoot={onTroubleshoot}
        installedAt="2026-01-01T09:00:00.000Z"
        heartbeat={widgetHeartbeat({
          installedAt: '2026-01-01T09:00:00.000Z',
          lastSeenAt: '2026-01-14T09:00:00.000Z',
          lastOrigin: 'www.acme.com',
        })}
        status={installStatus({
          installedAt: '2026-01-01T09:00:00.000Z',
          lastSeenAt: '2026-01-14T09:00:00.000Z',
          claimed: false,
          checking: false,
          now: Date.parse('2026-08-20T09:00:00.000Z'),
        })}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Not seen recently' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Live on your website' })).not.toBeInTheDocument();
    // The date it went quiet, in the state itself, not only in a property row.
    expect(screen.getByText(/we last saw this chatbot load on/i)).toBeInTheDocument();
    // "Check again" would poll for `widget_installed_at`, which this chatbot
    // already has, so the only offer is the checklist.
    expect(screen.queryByRole('button', { name: /check again/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'What to check' }));
    expect(onTroubleshoot).toHaveBeenCalledTimes(1);
  });

  it('renders an empty heartbeat as "not recorded", never as an outage', () => {
    renderWithRouter(
      <InstallStatusCard
        {...base}
        installedAt="2026-08-01T09:00:00.000Z"
        heartbeat={widgetHeartbeat({
          installedAt: '2026-08-01T09:00:00.000Z',
          lastSeenAt: null,
          lastOrigin: null,
        })}
        status={installStatus({ installedAt: '2026-08-01T09:00:00.000Z', claimed: false, checking: false })}
      />,
    );
    // Still "Live on your website": a chatbot installed before the heartbeat
    // existed has no reading, and reporting that as a fault would send the
    // customer to debug a working site.
    expect(screen.getByRole('heading', { name: 'Live on your website' })).toBeInTheDocument();
    expect(screen.getByText(/does not mean the chatbot is down/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('distinguishes a browser sighting from our own fetch', async () => {
    // This replaces a tooltip on the old single `Loaded from` row. The honesty
    // requirement did not go away with that row, it moved: the inventory has
    // to keep saying which signal it is quoting, because an observed origin is
    // a browser-supplied header and a probe is our own fetch, and the two are
    // trusted differently.
    renderWithRouter(
      <InstallStatusCard
        {...base}
        installedAt="2026-08-01T09:00:00.000Z"
        installs={[
          {
            hostname: 'shop.acme.com',
            state: 'live',
            observed_first_at: '2026-08-01T09:00:00.000Z',
            observed_last_at: '2026-08-19T11:30:00.000Z',
            probe_status: null,
            probe_checked_at: null,
            probe_detail: null,
            other_chatbot: null,
            allowed: true,
          },
        ]}
        status={installStatus({ installedAt: '2026-08-01T09:00:00.000Z', claimed: false, checking: false })}
      />,
    );
    expect(screen.getByText('shop.acme.com')).toBeInTheDocument();
    // Named as a visitor sighting, not as an unqualified fact about the site.
    expect(screen.getByText(/last visitor here/i)).toBeInTheDocument();
    expect(screen.getByText(/real visitors have loaded/i)).toBeInTheDocument();
  });

  it('links the allow-list to the page that now owns it', () => {
    renderWithRouter(
      <InstallStatusCard
        {...base}
        domains={['acme.com', '*.acme.com']}
        installedAt="2026-08-01T09:00:00.000Z"
        status={installStatus({ installedAt: '2026-08-01T09:00:00.000Z', claimed: false, checking: false })}
      />,
    );
    // A fragment on this same page: the allow-list is edited under the snippet
    // now, not on another tab.
    expect(screen.getByRole('link', { name: '2' })).toHaveAttribute('href', '#access');
  });

  it('says nothing about liveness before the widget has ever been seen', () => {
    renderWithRouter(
      <InstallStatusCard
        {...base}
        status={installStatus({ installedAt: null, claimed: false, checking: false })}
      />,
    );
    expect(screen.queryByText(/Last seen/i)).not.toBeInTheDocument();
  });

  it('announces the confirmation rather than only recolouring a dot', () => {
    renderWithRouter(
      <InstallStatusCard
        {...base}
        verifiedNow
        installedAt="2026-08-01T09:00:00.000Z"
        status={installStatus({ installedAt: '2026-08-01T09:00:00.000Z', claimed: false, checking: false })}
      />,
    );
    const live = screen.getByRole('status', { name: '' });
    expect(within(live).getByText('Your chatbot is live')).toBeInTheDocument();
  });
});

/* ----------------------------------------------------------- platform guide */

describe('PlatformGuide', () => {
  const base = {
    botKey: BOT_KEY,
    env: 'production' as const,
    attribution: true,
    resolving: false,
  };

  it('explains the emptiness rather than showing a blank panel', () => {
    render(<PlatformGuide {...base} platformId={null} onPlatformChange={vi.fn()} />);
    expect(screen.getByText('Choose a platform to see the steps')).toBeInTheDocument();
  });

  it('waits for the plan before quoting a snippet that might be wrong', () => {
    render(<PlatformGuide {...base} resolving platformId="html" onPlatformChange={vi.fn()} />);
    expect(screen.getByLabelText('Working out which snippet your plan needs')).toBeInTheDocument();
    expect(screen.queryByText(/Add the script tag/i)).not.toBeInTheDocument();
  });

  it('renders the chosen platform’s own steps, with the live key in them', () => {
    render(<PlatformGuide {...base} platformId="nextjs" onPlatformChange={vi.fn()} />);
    expect(screen.getByText('Import next/script in your root layout')).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(BOT_KEY)).length).toBeGreaterThan(0);
  });

  it('drops the attribution line from the steps for an entitled plan', () => {
    const { rerender } = render(
      <PlatformGuide {...base} platformId="html" onPlatformChange={vi.fn()} />,
    );
    expect(screen.getAllByText(/nofollow/).length).toBeGreaterThan(0);
    rerender(
      <PlatformGuide {...base} attribution={false} platformId="html" onPlatformChange={vi.fn()} />,
    );
    expect(screen.queryByText(/nofollow/)).not.toBeInTheDocument();
  });

  it('is a searchable control with a real accessible name', () => {
    render(<PlatformGuide {...base} platformId={null} onPlatformChange={vi.fn()} />);
    // The visible label, not the `Combobox`'s own fallback: inside a `Field`,
    // an `aria-label` would replace the words the user can actually read.
    expect(
      screen.getByRole('combobox', { name: 'What is your website built on?' }),
    ).toBeInTheDocument();
  });
});

/* ------------------------------------------------- emailing the developer */

/**
 * The handoff to whoever actually edits the website.
 *
 * This was a `mailto:` link. On a machine with no mail client configured it did
 * nothing at all, and its green tick was local state that meant "you clicked"
 * and reset on reload. What is covered here is the part a model test cannot
 * reach: that the control opens a field rather than navigating, that the sent
 * state comes from the server and so survives a reload, and that a repeat send
 * to the same person is confirmed rather than blocked.
 */
describe('SnippetSection — emailing the developer', () => {
  const base = {
    botKey: BOT_KEY,
    botName: 'Acme Assistant',
    botId: 7,
    env: 'production' as const,
    apiBaseUrl: 'https://api.oyechats.com',
    platform: null,
    attribution: true,
    resolving: false,
    devInviteEmail: null as string | null,
    devInviteSentAt: null as string | null,
  };

  async function open(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: /email this to my developer/i }));
    return screen.getByRole('textbox', { name: /developer'?s email/i });
  }

  it('opens a field instead of navigating away', async () => {
    const user = userEvent.setup();
    renderWithRouter(<SnippetSection {...base} />);

    expect(screen.queryByRole('textbox', { name: /developer'?s email/i })).not.toBeInTheDocument();
    await open(user);
    expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument();
  });

  it('does not spend a request on an address that cannot be one', async () => {
    const user = userEvent.setup();
    renderWithRouter(<SnippetSection {...base} />);

    const field = await open(user);
    await user.type(field, 'not-an-email');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    expect(sendInstallInvite).not.toHaveBeenCalled();
    expect(await screen.findByText(/valid email address/i)).toBeInTheDocument();
  });

  it('sends, and then says who it went to', async () => {
    const user = userEvent.setup();
    vi.mocked(sendInstallInvite).mockResolvedValue({
      email: 'dev@acme.com',
      sent_at: new Date().toISOString(),
      resent: false,
    });
    renderWithRouter(<SnippetSection {...base} />);

    const field = await open(user);
    await user.type(field, 'dev@acme.com');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    expect(sendInstallInvite).toHaveBeenCalledWith(7, 'dev@acme.com');
    // The address and the way back to it: both only exist in the sent state.
    expect(await screen.findByText('dev@acme.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send again/i })).toBeInTheDocument();
  });

  it('reports a send that already happened, on a page it has never opened', () => {
    // The whole point of storing this server-side: a reload, or another
    // device, still knows.
    renderWithRouter(
      <SnippetSection {...base} devInviteEmail="dev@acme.com" devInviteSentAt="2026-08-20T09:00:00Z" />,
    );

    expect(screen.getByText('dev@acme.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send again/i })).toBeInTheDocument();
  });

  it('confirms before mailing the same person twice, and still sends', async () => {
    const user = userEvent.setup();
    vi.mocked(sendInstallInvite).mockResolvedValue({
      email: 'dev@acme.com',
      sent_at: new Date().toISOString(),
      resent: true,
    });
    renderWithRouter(
      <SnippetSection {...base} devInviteEmail="dev@acme.com" devInviteSentAt="2026-08-20T09:00:00Z" />,
    );

    await user.click(screen.getByRole('button', { name: /send again/i }));
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    // A warning, not a wall.
    expect(await screen.findByText(/already sent to dev@acme\.com/i)).toBeInTheDocument();
    expect(sendInstallInvite).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /send it again/i }));
    expect(sendInstallInvite).toHaveBeenCalledWith(7, 'dev@acme.com');
  });

  it('treats a different address as a new handoff, with no confirmation', async () => {
    const user = userEvent.setup();
    vi.mocked(sendInstallInvite).mockResolvedValue({
      email: 'bob@acme.com',
      sent_at: new Date().toISOString(),
      resent: false,
    });
    renderWithRouter(
      <SnippetSection {...base} devInviteEmail="dev@acme.com" devInviteSentAt="2026-08-20T09:00:00Z" />,
    );

    await user.click(screen.getByRole('button', { name: /send again/i }));
    const field = screen.getByRole('textbox', { name: /developer'?s email/i });
    await user.clear(field);
    await user.type(field, 'bob@acme.com');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    expect(screen.queryByText(/already sent/i)).not.toBeInTheDocument();
    expect(sendInstallInvite).toHaveBeenCalledWith(7, 'bob@acme.com');
  });

  it('keeps the typed address when the send fails', async () => {
    const user = userEvent.setup();
    vi.mocked(sendInstallInvite).mockRejectedValue(new Error('The mail service did not answer.'));
    renderWithRouter(<SnippetSection {...base} />);

    const field = await open(user);
    await user.type(field, 'dev@acme.com');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    expect(await screen.findByText(/did not answer/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /developer'?s email/i })).toHaveValue('dev@acme.com');
  });

  it('still offers the customer their own mail client', async () => {
    const user = userEvent.setup();
    renderWithRouter(<SnippetSection {...base} />);

    await open(user);
    const mailto = screen.getByRole('link', { name: /my mail app/i });
    expect(mailto).toHaveAttribute('href', expect.stringContaining('mailto:'));
  });
});

/* --------------------------------------------------- the domain inventory */

describe('InstallStatusCard ▸ domains', () => {
  const base = {
    status: installStatus({ installedAt: '2026-08-01T10:00:00Z', claimed: false, checking: false }),
    installedAt: '2026-08-01T10:00:00Z',
    heartbeat: widgetHeartbeat({
      installedAt: '2026-08-01T10:00:00Z',
      lastSeenAt: '2026-08-31T10:00:00Z',
      lastOrigin: 'acme.com',
    }),
    website: 'https://acme.com',
    domains: [] as string[],
    accessHref: '#access',
    verifiedNow: false,
    checking: false,
    onStartVerifying: vi.fn(),
    onStopVerifying: vi.fn(),
    onTroubleshoot: vi.fn(),
    installs: [] as DomainInstall[],
    domainsLoading: false,
    domainsChecking: false,
    domainsCheckedAt: null,
    onCheckDomains: vi.fn(),
    domainsCheckError: null,
  };

  function install(over: Partial<DomainInstall> = {}): DomainInstall {
    return {
      hostname: 'acme.com',
      state: 'unchecked',
      observed_first_at: null,
      observed_last_at: null,
      probe_status: null,
      probe_checked_at: null,
      probe_detail: null,
      other_chatbot: null,
      allowed: true,
      ...over,
    };
  }

  it('lists every domain, not just the one that called most recently', () => {
    // The whole point of the rebuild. The old card read a single overwritten
    // column, so a chatbot on three sites showed one of them.
    renderWithRouter(
      <InstallStatusCard
        {...base}
        installs={[
          install({ hostname: 'acme.com', state: 'live', observed_last_at: '2026-08-31T10:00:00Z' }),
          install({ hostname: 'shop.acme.com', state: 'installed', probe_status: 'installed' }),
          install({ hostname: 'blog.acme.com', state: 'missing', probe_status: 'missing' }),
        ]}
      />,
    );
    expect(screen.getByText('acme.com')).toBeInTheDocument();
    expect(screen.getByText('shop.acme.com')).toBeInTheDocument();
    expect(screen.getByText('blog.acme.com')).toBeInTheDocument();
  });

  it('names the other chatbot when it finds one', () => {
    renderWithRouter(
      <InstallStatusCard
        {...base}
        installs={[
          install({
            hostname: 'acme.com',
            state: 'missing',
            probe_status: 'foreign',
            other_chatbot: 'bot-000000000000',
          }),
        ]}
      />,
    );
    // "Somebody else's chatbot is on your page" is only actionable if we say
    // which one, and this is the state no amount of passive data can reach.
    expect(screen.getByText('bot-000000000000')).toBeInTheDocument();
  });

  it('offers a check and reports it back to the caller', async () => {
    const onCheckDomains = vi.fn();
    renderWithRouter(<InstallStatusCard {...base} onCheckDomains={onCheckDomains} />);
    await userEvent.click(screen.getByRole('button', { name: /check my domains/i }));
    expect(onCheckDomains).toHaveBeenCalledOnce();
  });

  it('cannot be asked to check twice while a check is running', async () => {
    const onCheckDomains = vi.fn();
    renderWithRouter(
      <InstallStatusCard {...base} domainsChecking onCheckDomains={onCheckDomains} />,
    );
    const button = screen.getByRole('button', { name: /checking/i });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onCheckDomains).not.toHaveBeenCalled();
  });

  it('surfaces a failure to start rather than swallowing it', () => {
    renderWithRouter(
      <InstallStatusCard {...base} domainsCheckError="We could not start the check." />,
    );
    expect(screen.getByText('We could not start the check.')).toBeInTheDocument();
  });

  it('says something useful when there are no domains at all', () => {
    renderWithRouter(<InstallStatusCard {...base} installs={[]} />);
    // Not a fault: an empty allow-list means the chatbot runs anywhere, which
    // is the default a new account is in.
    expect(screen.getByText(/no domains recorded yet/i)).toBeInTheDocument();
  });

  it('no longer shows the single "Loaded from" origin', () => {
    // Superseded by the list, which says the same thing per domain and with
    // provenance. Keeping both was one fact printed twice.
    renderWithRouter(
      <InstallStatusCard
        {...base}
        installs={[install({ hostname: 'acme.com', state: 'live', observed_last_at: '2026-08-31T10:00:00Z' })]}
      />,
    );
    expect(screen.queryByText('Loaded from')).toBeNull();
  });
});

/**
 * What every platform's instructions must contain.
 *
 * `install_detection.scan_html` finds an install by two things and only two:
 * the loader FILENAME and a real bot key. If a platform's steps hand the
 * customer a snippet missing either one, then a customer who follows those
 * steps exactly gets a working widget that our own install check calls
 * "Snippet not found" - which is what happened on oyechats.com.
 *
 * This pins the contract from the instructions' side. The scanner's side is
 * pinned in api/tests/test_install_detection.py.
 */
describe('every platform hands out a snippet the install check can find', () => {
  const KEY = 'bot-cd72ea98fd30';

  // GTM is the one platform this cannot hold for, and not through any fault
  // of the instructions: the snippet goes into a container Google fetches and
  // runs in the browser, so nothing of ours is ever in the customer's HTML.
  const UNDETECTABLE_BY_DESIGN = new Set(['gtm']);

  for (const platform of platforms) {
    it(`${platform.id} names the loader and carries the key`, () => {
      const code = platform
        .getSteps(KEY, 'production', { attribution: true })
        .map((step) => step.code ?? '')
        .join('\n');

      expect(code).toContain('oyechats-widget.js');
      expect(code).toContain(KEY);
    });
  }

  it('records which platforms cannot be verified from outside, and why', () => {
    // A list, not a comment, so that adding a platform whose install is
    // invisible to a server-side fetch is a deliberate act with a name on it.
    expect([...UNDETECTABLE_BY_DESIGN]).toEqual(['gtm']);
  });
});

describe('the install panel opens on a platform', () => {
  it('starts on HTML rather than an empty select', () => {
    // The panel's whole job is to show steps. Opening on nothing showed a
    // reader who had just been told to install something a second thing to
    // choose first, and HTML is the one answer that is never wrong.
    expect(DEFAULT_PLATFORM_ID).toBe('html');
    expect(platforms.some((p) => p.id === DEFAULT_PLATFORM_ID)).toBe(true);
  });
});
