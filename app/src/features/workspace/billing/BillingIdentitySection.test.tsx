import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBillingDetails } from '../billingModel';
import type { BillingDetailsRaw } from './billingDetailsForm';
import { BillingIdentitySection } from './BillingIdentitySection';

/**
 * The tax identity is what makes an invoice claimable. Two failure modes are
 * pinned: a form that does not seed from what is stored (which then clears
 * every field it "saves"), and a checkout refusal that strands the customer on
 * a banner instead of the form that fixes it.
 */

const api = vi.hoisted(() => ({ updateBillingDetails: vi.fn() }));
vi.mock('../../../services/api', () => api);

const RAW: BillingDetailsRaw = {
  legal_name: 'Acme Private Limited',
  gstin: '29AAGCB7383J1Z4',
  billing_country: 'IN',
  billing_state_code: '29',
  billing_email: 'accounts@acme.example',
  billing_address: { line1: '12 MG Road', city: 'Bengaluru', postal_code: '560001' },
};

function renderSection(props: Partial<React.ComponentProps<typeof BillingIdentitySection>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <BillingIdentitySection
        details={buildBillingDetails(RAW)}
        raw={RAW}
        loading={false}
        error={null}
        demandedFields={null}
        onDemandCleared={vi.fn()}
        fallbackCountry="IN"
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.updateBillingDetails.mockReset().mockResolvedValue({});
});

describe('the stored identity', () => {
  it('shows what is on record, including the GSTIN and place of supply', () => {
    renderSection();
    expect(screen.getByText('Acme Private Limited')).toBeInTheDocument();
    expect(screen.getByText('29AAGCB7383J1Z4')).toBeInTheDocument();
    expect(screen.getByText('Karnataka')).toBeInTheDocument();
  });

  it('says plainly what an empty identity costs the customer', () => {
    renderSection({ details: buildBillingDetails({}), raw: {} });
    expect(screen.getByText(/cannot reclaim the GST/i)).toBeInTheDocument();
  });
});

describe('the edit form', () => {
  it('seeds from the stored record rather than opening blank', async () => {
    renderSection();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByLabelText(/legal name/i)).toHaveValue('Acme Private Limited');
    expect(screen.getByLabelText('GSTIN')).toHaveValue('29AAGCB7383J1Z4');
  });

  it('sends only what changed, so an untouched field is never cleared', async () => {
    renderSection();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const name = await screen.findByLabelText(/legal name/i);
    await userEvent.clear(name);
    await userEvent.type(name, 'Acme Global Private Limited');
    await userEvent.click(screen.getByRole('button', { name: /save details/i }));

    await waitFor(() =>
      expect(api.updateBillingDetails).toHaveBeenCalledWith({
        legal_name: 'Acme Global Private Limited',
      }),
    );
  });

  it('refuses an invalid GSTIN before it reaches the server', async () => {
    renderSection();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const gstin = await screen.findByLabelText('GSTIN');
    await userEvent.clear(gstin);
    await userEvent.type(gstin, '29AAGCB7383J1ZZ');
    await userEvent.click(screen.getByRole('button', { name: /save details/i }));

    expect(await screen.findByText(/valid 15-character GSTIN/i)).toBeInTheDocument();
    expect(api.updateBillingDetails).not.toHaveBeenCalled();
  });

  it('opens itself, explaining why, when checkout refused for missing fields', async () => {
    renderSection({ demandedFields: ['legal name', 'GSTIN'] });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/before we can charge you/i)).toBeInTheDocument();
    // Nothing has been charged, and the copy has to say so.
    expect(screen.getByText(/Nothing has been charged yet/i)).toBeInTheDocument();
  });

  it('cannot be dismissed while the save is in flight', async () => {
    api.updateBillingDetails.mockReturnValue(new Promise(() => {}));
    renderSection();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByRole('dialog');
    // Something has to actually change, or the form closes without a request.
    await userEvent.type(await screen.findByLabelText(/legal name/i), ' Ltd');
    await userEvent.click(screen.getByRole('button', { name: /save details/i }));
    await waitFor(() => expect(api.updateBillingDetails).toHaveBeenCalled());

    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
