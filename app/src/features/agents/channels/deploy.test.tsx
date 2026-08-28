import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallStatusCard } from './InstallStatusCard';
import { SnippetSection } from './SnippetSection';
import { PlatformGuide } from './PlatformGuide';
import { installStatus, widgetHeartbeat } from './deployModel';
import { recordActivationEvent, sendInstallInvite } from '../../../services/api';

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
 * The allow-list and session-continuity editors moved to Behaviour ▸ Access
 * (they were never install steps), and their tests moved with them to
 * `advanced/access.test.tsx`. The in-widget credit line merged into
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
    accessHref: '/chatbots/7/behaviour',
    verifiedNow: false,
    checking: false,
    onStartVerifying: vi.fn(),
    onStopVerifying: vi.fn(),
    onTroubleshoot: vi.fn(),
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
    // Label → value, not four stacked paragraphs.
    expect(screen.getAllByRole('term')).toHaveLength(4);
    expect(screen.getByText('First seen')).toBeInTheDocument();
    expect(screen.getByText('Last seen')).toBeInTheDocument();
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

  it('marks the origin as reported by the browser rather than as proof', async () => {
    renderWithRouter(
      <InstallStatusCard
        {...base}
        installedAt="2026-08-01T09:00:00.000Z"
        heartbeat={widgetHeartbeat({
          installedAt: '2026-08-01T09:00:00.000Z',
          lastSeenAt: '2026-08-19T11:30:00.000Z',
          lastOrigin: 'shop.acme.com',
        })}
        status={installStatus({ installedAt: '2026-08-01T09:00:00.000Z', claimed: false, checking: false })}
      />,
    );
    expect(screen.getByText('shop.acme.com')).toBeInTheDocument();
    // The caveat is a tooltip on the label it qualifies, not a 34-word sentence
    // in the smallest, faintest type on the page.
    await userEvent.hover(screen.getByRole('button', { name: 'About Loaded from' }));
    expect(await screen.findByText(/reported by the browser/i)).toBeInTheDocument();
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
    expect(screen.getByRole('link', { name: '2' })).toHaveAttribute(
      'href',
      '/chatbots/7/behaviour',
    );
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
