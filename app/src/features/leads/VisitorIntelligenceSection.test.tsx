import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VisitorIntelligenceSection } from './VisitorIntelligenceSection';
import { type LeadDetail } from './useLeadDetail';

/**
 * This panel is the one place IP data is shown to a salesperson, so its whole
 * job is to never overstate what that data proves.
 *
 * The API now decides employer-vs-network (`ip_intel_service` strips
 * `company_name` for hosting ranges, ISP ranges, carrier brands and subnet
 * labels). These tests pin the two shapes it can send and the distinct thing
 * each must render, a company card, or the network that routed the visitor,
 * never one hedged with a disclaimer.
 */

vi.mock('../../context/UpgradeModalContext', () => ({
  useUpgradeModal: () => ({ openUpgradeModal: vi.fn() }),
}));
vi.mock('../../services/api', () => ({
  sendLeadFollowUp: vi.fn(),
}));

function leadWith(ipIntel: Record<string, unknown> | null): LeadDetail {
  return {
    session_id: 's-1',
    visitor_metadata: ipIntel ? { browser: 'Chrome', ip_intel: ipIntel } : { browser: 'Chrome' },
    contact: null,
  } as unknown as LeadDetail;
}

describe('VisitorIntelligenceSection', () => {
  it('renders a company card when the API resolved an employer', () => {
    const { getByText } = render(
      <VisitorIntelligenceSection
        detail={leadWith({
          company_name: 'Infosys Limited',
          company_domain: 'infosys.com',
          company_type: 'business',
          asn_org: 'Infosys',
        })}
        unlocked
      />,
    );

    expect(getByText('Infosys Limited')).toBeInTheDocument();
    expect(getByText('infosys.com')).toBeInTheDocument();
  });

  it('still qualifies a company card as derived, never as confirmed', () => {
    const { getByText } = render(
      <VisitorIntelligenceSection
        detail={leadWith({ company_name: 'Infosys Limited', company_type: 'business' })}
        unlocked
      />,
    );

    expect(getByText(/not a confirmed employer/i)).toBeInTheDocument();
  });

  it('presents an ISP-only signal as the network, with no company card', () => {
    /* The measured production case: 9 of 10 resolutions were consumer ISPs.
       The API strips the name; the operator must see the carrier as routing
       information, not as the lead's employer. */
    const { getByText, queryByText } = render(
      <VisitorIntelligenceSection
        detail={leadWith({
          company_name: null,
          company_domain: null,
          company_type: 'isp',
          asn_org: 'Bharti Airtel Limited',
        })}
        unlocked
      />,
    );

    expect(getByText(/Connecting via/i)).toBeInTheDocument();
    expect(getByText('Bharti Airtel Limited')).toBeInTheDocument();
    // The give-away that it is being shown as a company rather than a network.
    expect(queryByText(/not a confirmed employer/i)).not.toBeInTheDocument();
  });

  it('warns when the connection is via VPN or proxy', () => {
    const { getByText } = render(
      <VisitorIntelligenceSection
        detail={leadWith({ company_name: null, asn_org: 'Some Host', is_vpn: true })}
        unlocked
      />,
    );

    expect(getByText(/company signal is unreliable/i)).toBeInTheDocument();
  });

  it('shows an empty state rather than an empty box when nothing resolved', () => {
    const { getByText } = render(<VisitorIntelligenceSection detail={leadWith(null)} unlocked />);

    expect(getByText(/No network details resolved/i)).toBeInTheDocument();
  });

  it('shows the locked teaser on plans without the entitlement', () => {
    const { getByText, queryByText } = render(
      <VisitorIntelligenceSection
        detail={leadWith({ company_name: 'Infosys Limited', company_type: 'business' })}
        unlocked={false}
      />,
    );

    expect(getByText(/locked/i)).toBeInTheDocument();
    // The gated data must not leak into the teaser.
    expect(queryByText('Infosys Limited')).not.toBeInTheDocument();
  });
});

describe('VisitorIntelligenceSection section naming', () => {
  /* The panel shows network context, not "intelligence about the visitor", and
     the locked teaser advertises the same section to plans that cannot see it.
     If the two ever drift apart, an upgrade lands the user somewhere that
     appears to be a different feature. */
  it('titles the section "Network & risk" whether unlocked or locked', () => {
    const detail = leadWith({ company_name: 'Infosys Limited', company_type: 'business' });

    const unlockedTitle = render(<VisitorIntelligenceSection detail={detail} unlocked />)
      .container.querySelector('h3')?.textContent;
    const lockedTitle = render(<VisitorIntelligenceSection detail={detail} unlocked={false} />)
      .container.querySelector('h3')?.textContent;

    expect(unlockedTitle).toBe('Network & risk');
    expect(lockedTitle).toBe('Network & risk');
  });
});
