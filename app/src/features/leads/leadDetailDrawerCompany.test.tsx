import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LeadDetailDrawer } from './LeadDetailDrawer';
import { type LeadDetail } from './useLeadDetail';

/**
 * The company row as actually RENDERED.
 *
 * `companyDisplay` is unit-tested, but a review pointed the drawer back at
 * `detail.contact.company` — reverting the entire user-visible payoff of the
 * feature — and all 189 tests stayed green. A pure function with an untested
 * call site is the same defect this whole commit exists to fix, one level
 * down: something built, and nothing exercising it.
 */

vi.mock('../../services/api', () => ({ sendLeadFollowUp: vi.fn() }));
vi.mock('../../context/UpgradeModalContext', () => ({
  useUpgradeModal: () => ({ openUpgradeModal: vi.fn() }),
}));

function drawerWith(contact: Record<string, unknown>) {
  const detail = {
    session_id: 's-1',
    contact,
    location: null,
    device: null,
    visitor_metadata: {},
    messages: [],
    score: null,
    tier: null,
  } as unknown as LeadDetail;

  return render(
    <LeadDetailDrawer
      data={{ status: 'ready', detail, error: null }}
      onClose={vi.fn()}
      visitorIntelligenceUnlocked
    />,
  ).container;
}

describe('LeadDetailDrawer company row', () => {
  it('renders the resolved name AND keeps the domain visible', () => {
    const c = drawerWith({ company: 'infosys.com', company_name: 'Infosys Limited' });

    expect(c.textContent).toContain('Infosys Limited');
    expect(c.textContent).toContain('infosys.com');
  });

  it('falls back to the bare domain when nothing was resolved', () => {
    /* The common case: a lower plan, the toggle off, or a site that declares
       no identity. Showing nothing would regress behaviour that predates the
       feature. */
    const c = drawerWith({ company: 'infosys.com', company_name: null });

    expect(c.textContent).toContain('infosys.com');
  });
});
