import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LeadEnrichmentSection } from './LeadEnrichmentSection';

/**
 * The two metered enrichments, on the side of the wire that can PERSIST a wrong
 * value.
 *
 * A review once mutated both parses AND deleted `company_lookup_enabled` from
 * the save payload, and every test stayed green — `features/agents/advanced/`
 * had no test file at all. That is the dangerous direction: the page renders
 * every switch off, the customer edits something unrelated, presses Save, and
 * the PATCH writes `false, false`. A paying customer loses both paid
 * enrichments and nothing in lint, tsc, build or vitest says a word.
 *
 * The parse and payload halves now live in `qualification.draft.test.ts`; this
 * file covers what the control itself tells the customer.
 */

const base = {
  emailVerificationEnabled: true,
  onToggleEmailVerification: vi.fn(),
  emailVerificationPlanAllows: true,
  companyLookupEnabled: true,
  onToggleCompanyLookup: vi.fn(),
  companyLookupPlanAllows: true,
};

describe('LeadEnrichmentSection', () => {
  it('renders both enrichments as separate switches', () => {
    render(<LeadEnrichmentSection {...base} />);

    expect(screen.getByRole('switch', { name: /Email verification/i })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Company lookup/i })).toBeInTheDocument();
  });

  it('states the company-lookup charge as a CONDITION, not a flat price', () => {
    /* Most visitors resolve to a consumer ISP and name no employer, and those
       cost nothing. A bare "10 credits" reads as 10 per visitor. */
    render(<LeadEnrichmentSection {...base} />);

    expect(screen.getByText(/only when a company is found/i)).toBeInTheDocument();
  });

  it('disables a switch the plan does not include, and names the plan', () => {
    render(<LeadEnrichmentSection {...base} companyLookupPlanAllows={false} />);

    expect(screen.getByRole('switch', { name: /Company lookup/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('switch', { name: /Email verification/i })).not.toHaveAttribute(
      'aria-disabled',
    );
    expect(screen.getByText(/Included on the Professional plan/i)).toBeInTheDocument();
  });

  it('shows a locked switch as OFF without clearing the stored value', async () => {
    /* On a plan without the feature the switch does nothing, so it reads off
       whatever is stored. The stored value is left alone so it comes back
       intact on upgrade — hence no callback fires. */
    const onToggle = vi.fn();
    render(
      <LeadEnrichmentSection
        {...base}
        companyLookupEnabled
        companyLookupPlanAllows={false}
        onToggleCompanyLookup={onToggle}
      />,
    );

    const locked = screen.getByRole('switch', { name: /Company lookup/i });
    expect(locked).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(locked);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('toggling one does not touch the other', async () => {
    const onEmail = vi.fn();
    const onCompany = vi.fn();
    render(
      <LeadEnrichmentSection
        {...base}
        onToggleEmailVerification={onEmail}
        onToggleCompanyLookup={onCompany}
      />,
    );

    await userEvent.click(screen.getByRole('switch', { name: /Company lookup/i }));

    expect(onCompany).toHaveBeenCalledTimes(1);
    expect(onEmail).not.toHaveBeenCalled();
  });

  it('is reachable and operable from the keyboard', async () => {
    const onEmail = vi.fn();
    render(<LeadEnrichmentSection {...base} onToggleEmailVerification={onEmail} />);

    const toggle = screen.getByRole('switch', { name: /Email verification/i });
    toggle.focus();
    await userEvent.keyboard(' ');

    expect(onEmail).toHaveBeenCalledTimes(1);
    expect(onEmail.mock.calls[0][0]).toBe(false);
  });
});
