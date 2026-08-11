import { fireEvent, render } from '@testing-library/react';
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

describe('the rest of what the resolver produces', () => {
  /* `company_description` and `company_logo_url` were stored, migrated,
     plan-gated, serialized on every leads response and typed in the frontend
     — and rendered nowhere. Two thirds of the paid enrichment was invisible. */
  it('shows the description', () => {
    const c = drawerWith({
      company: 'infosys.com',
      company_name: 'Infosys Limited',
      company_description: 'Infosys is an IT services company.',
    });

    expect(c.textContent).toContain('Infosys is an IT services company.');
  });

  it('shows the logo in place of the generic icon', () => {
    const c = drawerWith({
      company: 'infosys.com',
      company_name: 'Infosys Limited',
      company_logo_url: 'https://infosys.com/logo.png',
    });

    const img = c.querySelector('img[src="https://infosys.com/logo.png"]');
    expect(img).not.toBeNull();
  });

  it('falls back to the generic icon when a logo fails to load', () => {
    /* A third-party URL from the company's own site: it can 404, move, or be
       hotlink-blocked at any time. A broken-image glyph in a lead drawer looks
       like our bug. */
    const c = drawerWith({
      company: 'infosys.com',
      company_name: 'Infosys Limited',
      company_logo_url: 'https://infosys.com/gone.png',
    });

    // `fireEvent`, not a raw dispatchEvent — React's onError is a synthetic
    // handler and does not see a natively dispatched event.
    fireEvent.error(c.querySelector('img') as HTMLImageElement);
    expect(c.querySelector('img')).toBeNull();
  });

  it('renders no description block when the resolver returned none', () => {
    const c = drawerWith({ company: 'infosys.com', company_name: 'Infosys Limited' });
    expect(c.textContent).toContain('Infosys Limited');
    expect(c.querySelector('img')).toBeNull();
  });
});

describe('the logo is a third-party URL the visitor chose', () => {
  /* The visitor picks which domain we crawl by typing an email at it, so a
     hostile site can point `og:image` at a beacon. Without these attributes it
     fires from the operator's authenticated admin session and reports their
     IP, UA and the moment they opened the lead. */
  it('sends no referrer and loads lazily', () => {
    const c = drawerWith({
      company: 'evil.example',
      company_name: 'Evil Ltd',
      company_logo_url: 'https://evil.example/px.gif?lead=42',
    });

    const img = c.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(img.getAttribute('loading')).toBe('lazy');
  });
});
