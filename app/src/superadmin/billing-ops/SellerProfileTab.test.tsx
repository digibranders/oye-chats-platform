import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SellerProfileTab } from './SellerProfileTab';
import type { SellerProfile } from './types';

const get = vi.fn();
const put = vi.fn();

vi.mock('../../services/api', () => ({
  httpClient: {
    get: (...args: unknown[]) => get(...args),
    put: (...args: unknown[]) => put(...args),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  getApiBaseUrl: () => '',
}));

function profile(overrides: Partial<SellerProfile> = {}): SellerProfile {
  return {
    configured: true,
    gst_enabled: true,
    legal_name: 'Digibranders Private Limited',
    trade_name: 'OyeChats',
    gstin: '29AABCU9603R1ZM',
    address_lines: ['1 Example Road', 'Bengaluru 560001'],
    state_code: '29',
    country: 'IN',
    sac_code: '997331',
    tax_rate_bps: 1800,
    price_inclusive: true,
    lut_active: false,
    lut_number: null,
    invoice_prefix: 'DB',
    logo_url: null,
    cin: null,
    phone: null,
    website: null,
    support_email: null,
    ...overrides,
  };
}

/**
 * A data router: the save bar guards navigation while the draft is dirty, and
 * `useBlocker` exists only on one.
 */
function mount() {
  const router = createMemoryRouter([{ path: '/', element: <SellerProfileTab /> }]);
  return render(<RouterProvider router={router} />);
}

describe('SellerProfileTab', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * Numbering is blocked until this is saved once, so a platform charging
   * customers with an unsaved profile produces captured payments and no tax
   * documents — the `unnumbered_charges` anomaly on the Reconciliation tab.
   */
  it('leads with the fact that nothing has ever been saved', async () => {
    get.mockResolvedValue({ data: profile({ configured: false, legal_name: '' }) });
    mount();
    expect(await screen.findByText('No seller profile has ever been saved')).toBeInTheDocument();
    expect(screen.getByText(/Invoice numbering is blocked/)).toBeInTheDocument();
  });

  it('does not raise that alarm once it is configured', async () => {
    get.mockResolvedValue({ data: profile() });
    mount();
    await screen.findByDisplayValue('Digibranders Private Limited');
    expect(screen.queryByText('No seller profile has ever been saved')).not.toBeInTheDocument();
  });

  it('shows the two derived facts as derived, not as controls', async () => {
    get.mockResolvedValue({ data: profile() });
    mount();
    expect(await screen.findByText('GST tax invoices')).toBeInTheDocument();
    expect(screen.getByText(/derived by the server/)).toBeInTheDocument();
  });

  it('locks the state code while a GSTIN is stored, and says why', async () => {
    get.mockResolvedValue({ data: profile() });
    mount();
    const field = await screen.findByLabelText(/GST state code/i);
    expect(field).toBeDisabled();
    expect(field).toHaveValue('29');
    expect(screen.getByText(/Derived from the GSTIN/)).toBeInTheDocument();
  });

  it('lets the state code be set when there is no GSTIN', async () => {
    get.mockResolvedValue({ data: profile({ gstin: null, gst_enabled: false }) });
    mount();
    expect(await screen.findByLabelText(/GST state code/i)).toBeEnabled();
  });

  it('offers no control for tax-exclusive pricing, which the server rejects', async () => {
    get.mockResolvedValue({ data: profile() });
    mount();
    expect(await screen.findByText(/Prices are tax-inclusive and cannot be otherwise/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/price inclusive/i)).not.toBeInTheDocument();
  });

  it('refuses to save an invalid prefix, and does not send anything', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: profile() });
    mount();

    const prefix = await screen.findByLabelText(/invoice prefix/i);
    await user.clear(prefix);
    await user.type(prefix, 'CN');

    // Twice, deliberately: once under the field, once named in the save bar so
    // the reader does not have to hunt three cards for it.
    expect(await screen.findAllByText(/reserved for another document series/)).toHaveLength(2);
    expect(screen.getByRole('button', { name: /save seller profile/i })).toBeDisabled();
    expect(put).not.toHaveBeenCalled();
  });

  it('sends the whole profile, with the state code omitted under a GSTIN', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: profile() });
    put.mockResolvedValue({ data: profile() });
    mount();

    const name = await screen.findByLabelText(/registered legal name/i);
    await user.clear(name);
    await user.type(name, 'Digibranders Pvt Ltd');
    await user.click(screen.getByRole('button', { name: /save seller profile/i }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    const [path, body] = put.mock.calls[0];
    expect(path).toBe('/superadmin/billing/seller-profile');
    expect(body).toMatchObject({
      legal_name: 'Digibranders Pvt Ltd',
      gstin: '29AABCU9603R1ZM',
      address_lines: ['1 Example Road', 'Bengaluru 560001'],
      tax_rate_bps: 1800,
      invoice_prefix: 'DB',
    });
    expect(body).not.toHaveProperty('state_code');
    expect(body).not.toHaveProperty('price_inclusive');
  });

  it('says that already-issued documents keep their own snapshot', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: profile() });
    put.mockResolvedValue({ data: profile() });
    mount();

    const name = await screen.findByLabelText(/registered legal name/i);
    await user.type(name, ' Two');
    await user.click(screen.getByRole('button', { name: /save seller profile/i }));

    expect(await screen.findByText('All changes saved.')).toBeInTheDocument();
    // The consequence stays on screen whether or not a save just happened.
    expect(screen.getByText(/keep their own snapshot/)).toBeInTheDocument();
  });

  it('shows the server’s 422 rather than claiming a save', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: profile() });
    put.mockRejectedValue(
      Object.assign(new Error('failed'), {
        response: { status: 422, data: { detail: 'GSTIN failed format/checksum validation' } },
      }),
    );
    mount();

    const name = await screen.findByLabelText(/registered legal name/i);
    await user.type(name, ' Two');
    await user.click(screen.getByRole('button', { name: /save seller profile/i }));

    expect(await screen.findByText('GSTIN failed format/checksum validation')).toBeInTheDocument();
    expect(screen.queryByText('All changes saved.')).not.toBeInTheDocument();
  });

  it('discards edits back to what is stored', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: profile() });
    mount();

    const name = await screen.findByLabelText(/registered legal name/i);
    await user.clear(name);
    await user.type(name, 'Something else');
    await user.click(screen.getByRole('button', { name: /^discard$/i }));

    expect(screen.getByLabelText(/registered legal name/i)).toHaveValue('Digibranders Private Limited');
  });

  /* --------------------------------------------------------- four states */

  it('shows a placeholder while it loads', async () => {
    get.mockReturnValue(new Promise(() => {}));
    const { container } = mount();
    expect(container.querySelector('[aria-busy]')).toBeInTheDocument();
  });

  it('explains a failure and offers the way back', async () => {
    get.mockRejectedValue(new Error('Database unreachable'));
    mount();
    expect(await screen.findByText(/Database unreachable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('says the account is not permitted rather than showing a blank form', async () => {
    get.mockRejectedValue(
      Object.assign(new Error('failed'), {
        response: { status: 403, data: { detail: 'No privileges.' } },
      }),
    );
    mount();
    expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
    expect(screen.queryByLabelText(/registered legal name/i)).not.toBeInTheDocument();
  });
});
