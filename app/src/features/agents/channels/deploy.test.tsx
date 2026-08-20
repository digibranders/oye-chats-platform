import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AllowedDomainsSection } from './AllowedDomainsSection';
import { AttributionSection } from './AttributionSection';
import { InstallStatusCard } from './InstallStatusCard';
import { PlatformGuide } from './PlatformGuide';
import { SessionContinuitySection } from './SessionContinuitySection';
import { installStatus, widgetHeartbeat } from './deployModel';

/**
 * What is covered here is what a unit test of the model cannot reach: that the
 * page refuses to let a customer lock themselves out without saying so, that
 * every control can be driven from the keyboard, and that each of the four
 * states a surface owes its user actually renders one.
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
    verifiedNow: false,
    checking: false,
    onStartVerifying: vi.fn(),
    onStopVerifying: vi.fn(),
    troubleshootHref: '#deploy-troubleshooting',
  };

  it('says "waiting", not "error", before anyone has installed anything', () => {
    render(
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
    render(
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
    render(
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

  it('turns the claim into a real problem, with somewhere to go', () => {
    render(
      <InstallStatusCard
        {...base}
        status={installStatus({ installedAt: null, claimed: true, checking: false })}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Not detected yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'What to check' })).toHaveAttribute(
      'href',
      '#deploy-troubleshooting',
    );
    expect(screen.getByRole('button', { name: /Check again/i })).toBeInTheDocument();
  });

  it('keeps the first sighting and the heartbeat as two separate facts', () => {
    render(
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
    expect(screen.getByText(/First seen/)).toBeInTheDocument();
    expect(screen.getByText(/Last seen/)).toBeInTheDocument();
  });

  it('renders an empty heartbeat as "not recorded", never as an outage', () => {
    render(
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

  it('marks the origin as reported by the browser rather than as proof', () => {
    render(
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
    expect(screen.getByText(/reported by the browser/i)).toBeInTheDocument();
    expect(screen.getByText(/never proof of anything/i)).toBeInTheDocument();
  });

  it('says nothing about liveness before the widget has ever been seen', () => {
    render(
      <InstallStatusCard
        {...base}
        status={installStatus({ installedAt: null, claimed: false, checking: false })}
      />,
    );
    expect(screen.queryByText(/Last seen/i)).not.toBeInTheDocument();
  });

  it('announces the confirmation rather than only recolouring a dot', () => {
    render(
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

/* ---------------------------------------------------------- allowed domains */

describe('AllowedDomainsSection', () => {
  const base = {
    website: 'https://www.acme.com',
    initialDomains: [] as string[],
    initialEnabled: false,
    saving: false,
  };

  it('adds a domain from the keyboard and normalises it the way the server will', async () => {
    render(<AllowedDomainsSection {...base} onSave={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Allowed domains' });
    await userEvent.type(input, 'https://WWW.Acme.com/pricing{Enter}');
    expect(screen.getByRole('button', { name: 'Remove acme.com' })).toBeInTheDocument();
  });

  it('explains a rejected entry instead of silently dropping it', async () => {
    render(<AllowedDomainsSection {...base} onSave={vi.fn()} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Allowed domains' }), 'nonsense{Enter}');
    expect(screen.getByText(/is not a domain/i)).toBeInTheDocument();
  });

  it('warns before saving a list that would block the customer’s own website', async () => {
    const onSave = vi.fn();
    render(
      <AllowedDomainsSection
        {...base}
        initialDomains={['acme.com']}
        initialEnabled
        onSave={onSave}
      />,
    );
    // Dirty the form without changing the risk, so Save is reachable.
    await userEvent.click(screen.getByRole('checkbox', { name: /Only allow the domains/i }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Only allow the domains/i }));

    await userEvent.click(screen.getByRole('button', { name: 'Save domains' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/will block your own website/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/www\.acme\.com/)).toBeInTheDocument();
    // Nothing is written until the customer accepts the consequence.
    expect(onSave).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it('saves without a confirmation once the wildcard covers www', async () => {
    const onSave = vi.fn().mockResolvedValue({
      allowed_domains: ['acme.com', '*.acme.com'],
      domain_check_enabled: true,
    });
    render(
      <AllowedDomainsSection
        {...base}
        initialDomains={['acme.com', '*.acme.com']}
        initialEnabled={false}
        onSave={onSave}
      />,
    );
    await userEvent.click(screen.getByRole('checkbox', { name: /Only allow the domains/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save domains' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('offers the apex and the wildcard together, because www is a subdomain', async () => {
    const onSave = vi.fn();
    render(<AllowedDomainsSection {...base} onSave={onSave} />);
    await userEvent.click(screen.getByRole('button', { name: /Add acme\.com and \*\.acme\.com/ }));
    expect(screen.getByRole('button', { name: 'Remove acme.com' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove *.acme.com' })).toBeInTheDocument();
  });

  it('keeps a failed save on the page, beside the control that produced it', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Domain limit reached.'));
    render(<AllowedDomainsSection {...base} onSave={onSave} />);
    await userEvent.click(screen.getByRole('checkbox', { name: /Only allow the domains/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save domains' }));
    expect(await screen.findByText('Domain limit reached.')).toBeInTheDocument();
  });

  it('adopts what the server actually stored rather than what was typed', async () => {
    const onSave = vi.fn().mockResolvedValue({
      allowed_domains: ['acme.com'],
      domain_check_enabled: true,
    });
    render(<AllowedDomainsSection {...base} initialDomains={['acme.com', 'stale.com']} onSave={onSave} />);
    await userEvent.click(screen.getByRole('checkbox', { name: /Only allow the domains/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save domains' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove stale.com' })).not.toBeInTheDocument(),
    );
  });
});

/* ------------------------------------------------------- session continuity */

describe('SessionContinuitySection', () => {
  const base = {
    website: 'https://acme.com',
    initialShareDomain: null,
    saving: false,
  };

  it('presents a working feature as working, not as unconfigured', () => {
    render(<SessionContinuitySection {...base} onSave={vi.fn()} />);
    expect(screen.getByText('Automatic')).toBeInTheDocument();
    expect(screen.getByText('On, with nothing to set up')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('rejects a wildcard with the reason it cannot work, before any request', async () => {
    const onSave = vi.fn();
    render(<SessionContinuitySection {...base} onSave={onSave} />);
    await userEvent.type(
      screen.getByRole('textbox', { name: /Pin a parent domain/i }),
      '*.acme.com',
    );
    expect(screen.getByText(/A wildcard will not work here/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('separates continuing a conversation from showing the widget', () => {
    render(<SessionContinuitySection {...base} onSave={vi.fn()} />);
    expect(screen.getByText(/does not put the widget on those pages/i)).toBeInTheDocument();
  });

  it('saves a pinned parent and reports back what was stored', async () => {
    const onSave = vi.fn().mockResolvedValue('acme.com');
    render(<SessionContinuitySection {...base} onSave={onSave} />);
    await userEvent.type(
      screen.getByRole('textbox', { name: /Pin a parent domain/i }),
      'https://www.acme.com/',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ session_share_domain: 'acme.com' }),
    );
    expect(await screen.findByText('Pinned')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------- attribution */

describe('AttributionSection', () => {
  const base = {
    entitlementsLoading: false,
    initialText: null,
    initialUrl: null,
    saving: false,
  };

  it('names the plan and the way out rather than hiding the control', () => {
    renderWithRouter(<AttributionSection {...base} entitled={false} onSave={vi.fn()} />);
    expect(screen.getByText(/White-label branding is on Standard and above/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/billing');
    expect(screen.queryByRole('textbox', { name: 'Wording' })).not.toBeInTheDocument();
  });

  it('waits rather than guessing while the plan is still resolving', () => {
    renderWithRouter(<AttributionSection {...base} entitled={false} entitlementsLoading onSave={vi.fn()} />);
    expect(screen.getByText(/Checking what your plan includes/)).toBeInTheDocument();
    expect(screen.queryByText(/White-label branding is on/)).not.toBeInTheDocument();
  });

  it('adds the scheme the backend demands rather than surfacing a 422', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderWithRouter(<AttributionSection {...base} entitled onSave={onSave} />);
    const url = screen.getByRole('textbox', { name: /Where it links to/i });
    await userEvent.clear(url);
    await userEvent.type(url, 'acme.com');
    await userEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        branding_text: 'Powered by OyeChats',
        branding_url: 'https://acme.com',
      }),
    );
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
    expect(screen.getByRole('combobox', { name: 'Website platform' })).toBeInTheDocument();
  });
});
