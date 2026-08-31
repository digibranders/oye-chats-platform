import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VisitorPanel } from './VisitorPanel';
import { profileFromSession } from './visitorProfile';
import type { SessionDetails } from './liveChatProtocol';

/**
 * The company the system identified, in front of the operator talking to them.
 *
 * `visitor_metadata` reached the inbox all the way through the query layer and
 * the protocol types and was then rendered nowhere: the only surface that ever
 * showed it was the Leads drawer, read after the conversation. An operator
 * mid-chat could not see who they were talking to.
 */

function details(overrides: Partial<SessionDetails> = {}): SessionDetails {
  return {
    session_id: 's-1',
    status: 'live',
    location: 'Pune, India',
    device: 'Chrome · macOS',
    handoff_reason: null,
    created_at: '2026-08-20T08:24:00Z',
    last_active_at: '2026-08-20T08:31:00Z',
    message_count: 6,
    bot_name: 'Acme Support',
    department_name: null,
    operator_name: null,
    visitor_metadata: null,
    page_url: null,
    referrer: null,
    visitor_rating: null,
    language_code: null,
    locale: null,
    bant: null,
    lead_info: null,
    quotation: null,
    ...overrides,
  };
}

function renderPanel(session: SessionDetails, visitorIntelligence = true) {
  return render(
    <VisitorPanel
      profile={profileFromSession(session, 'Visitor')}
      sessionId={session.session_id}
      visitorIntelligence={visitorIntelligence}
    />,
  );
}

describe('VisitorPanel — the identified company', () => {
  it('shows the company the visitor’s network resolved to', () => {
    renderPanel(
      details({
        visitor_metadata: {
          ip_intel: { company_name: 'Northwind Logistics', company_domain: 'northwind.com' },
        },
      }),
    );

    expect(screen.getByText('Northwind Logistics')).toBeInTheDocument();
    expect(screen.getByText('northwind.com')).toBeInTheDocument();
  });

  it('names the network instead when there is no company behind it', () => {
    // A visitor on home broadband legitimately resolves to no company at all —
    // the backend returns null rather than passing off an ISP as an employer —
    // and the honest rendering is the network that routed them.
    renderPanel(
      details({
        visitor_metadata: { ip_intel: { company_name: null, asn_org: 'Jio Fiber' } },
      }),
    );

    expect(screen.getByText('Jio Fiber')).toBeInTheDocument();
  });

  it('renders no empty slot when the lookup resolved nothing at all', () => {
    renderPanel(details({ visitor_metadata: { ip_intel: { resolved_for_ip: null } } }));

    expect(screen.queryByText('Their network')).toBeNull();
  });

  it('warns when the address is masked, because the signal is then unreliable', () => {
    renderPanel(
      details({
        visitor_metadata: { ip_intel: { company_name: 'Northwind Logistics', is_vpn: true } },
      }),
    );

    expect(screen.getByText(/VPN or proxy/i)).toBeInTheDocument();
  });

  it('withholds it on a plan that does not include the lookup', () => {
    // `/session/{id}/details` has no visitor-intelligence gate of its own, so
    // the workspace's plan is the only thing standing between a downgraded
    // account and the company its old lookups resolved. The Leads drawer gates
    // the identical field the identical way.
    renderPanel(
      details({ visitor_metadata: { ip_intel: { company_name: 'Northwind Logistics' } } }),
      false,
    );

    expect(screen.queryByText('Northwind Logistics')).toBeNull();
    expect(screen.queryByText('Their network')).toBeNull();
  });
});
