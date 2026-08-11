import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LeadEnrichmentSection } from './LeadEnrichmentSection';
import { parseSettings, toSettingsPayload } from './advanced.config';

/**
 * The two metered-enrichment toggles, on the side of the wire that can
 * PERSIST a wrong value.
 *
 * A review mutated both parses to `=== true` AND deleted
 * `company_lookup_enabled` from the save payload, and all 166 tests stayed
 * green — `features/agents/advanced/` had no test file at all. That is the
 * dangerous direction: the Advanced tab renders every switch OFF, the customer
 * edits an unrelated setting and hits Save, and the PATCH writes
 * `false, false`. A paying customer silently loses both paid enrichments and
 * nothing in lint, tsc, build or vitest says a word.
 */

vi.mock('../../../context/UpgradeModalContext', () => ({
  useUpgradeModal: () => ({ openUpgradeModal: vi.fn() }),
}));

describe('advanced.config parsing of the enrichment toggles', () => {
  it('reads an ABSENT field as ON, matching the column default', () => {
    /* `!== false`, not `=== true`. Both columns default ON server-side, so an
       older API build or a partial payload must not read as "switched off" —
       that value then round-trips back on the next Save. */
    const draft = parseSettings({});

    expect(draft.emailVerificationEnabled).toBe(true);
    expect(draft.companyLookupEnabled).toBe(true);
  });

  it('reads an explicit false as OFF', () => {
    const draft = parseSettings({
      email_verification_enabled: false,
      company_lookup_enabled: false,
    });

    expect(draft.emailVerificationEnabled).toBe(false);
    expect(draft.companyLookupEnabled).toBe(false);
  });

  it('reads an explicit true as ON', () => {
    const draft = parseSettings({
      email_verification_enabled: true,
      company_lookup_enabled: true,
    });

    expect(draft.emailVerificationEnabled).toBe(true);
    expect(draft.companyLookupEnabled).toBe(true);
  });

  it('keeps the two toggles independent', () => {
    const draft = parseSettings({
      email_verification_enabled: false,
      company_lookup_enabled: true,
    });

    expect(draft.emailVerificationEnabled).toBe(false);
    expect(draft.companyLookupEnabled).toBe(true);
  });
});

describe('LeadEnrichmentSection', () => {
  const base = {
    emailVerificationEnabled: true,
    onToggleEmailVerification: vi.fn(),
    emailVerificationPlanAllows: true,
    companyLookupEnabled: true,
    onToggleCompanyLookup: vi.fn(),
    companyLookupPlanAllows: true,
  };

  it('renders both enrichments as separate controls', () => {
    render(<LeadEnrichmentSection {...base} />);

    expect(screen.getByRole('switch', { name: /email verification/i })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /company lookup/i })).toBeInTheDocument();
  });

  it('states the company-lookup charge as a CONDITION, not a flat price', () => {
    /* Most visitors resolve to a consumer ISP and cost nothing. A bare
       "10 credits" reads as 10 per visitor — which is what it would have been
       before the charge moved behind a successful identification. */
    render(<LeadEnrichmentSection {...base} />);

    expect(screen.getByText(/only when a company is found/i)).toBeInTheDocument();
  });

  it('disables a switch the plan does not include, and names the plan', () => {
    render(<LeadEnrichmentSection {...base} companyLookupPlanAllows={false} />);

    expect(screen.getByRole('switch', { name: /company lookup/i })).toBeDisabled();
    expect(screen.getByRole('switch', { name: /email verification/i })).not.toBeDisabled();
    expect(screen.getByText(/Professional plan/i)).toBeInTheDocument();
  });

  it('toggling one does not touch the other', () => {
    const onEmail = vi.fn();
    const onCompany = vi.fn();
    render(
      <LeadEnrichmentSection {...base} onToggleEmailVerification={onEmail} onToggleCompanyLookup={onCompany} />,
    );

    screen.getByRole('switch', { name: /company lookup/i }).click();

    expect(onCompany).toHaveBeenCalledTimes(1);
    expect(onEmail).not.toHaveBeenCalled();
  });
});

describe('the Advanced save payload', () => {
  /* The parse tests above cover READING. This covers WRITING, which is the
     direction that persists a wrong value: a review deleted
     `company_lookup_enabled` from the payload and every test stayed green, so
     a paying customer's enrichment would be silently switched off the next
     time they saved anything at all.

     The payload was an inline object literal in the save handler. It is now a
     pure function so this can assert it directly rather than scraping source. */
  it('sends both enrichment toggles, matching the draft', () => {
    const payload = toSettingsPayload({
      ...parseSettings({}),
      emailVerificationEnabled: false,
      companyLookupEnabled: true,
    });

    expect(payload.email_verification_enabled).toBe(false);
    expect(payload.company_lookup_enabled).toBe(true);
  });
});
