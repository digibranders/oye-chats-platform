import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GstrExportTab } from './GstrExportTab';
import { pickOption } from '../../test/select';
import { monthLabel, recentMonths } from './gstr';

const get = vi.fn();

vi.mock('../../services/api', () => ({
  httpClient: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  getApiBaseUrl: () => '',
}));

const HEADER = 'section,invoice_number,invoice_date';
const WITH_ROWS = [HEADER, 'B2B,DB/1,2026-07-01', 'B2B,DB/2,2026-07-02', '', 'SUMMARY,B2B,2'].join('\n');
const WITHOUT_ROWS = [HEADER, '', 'SUMMARY,TOTAL,0'].join('\n');

const createObjectURL = vi.fn(() => 'blob:mock');
const revokeObjectURL = vi.fn();

function mount() {
  return render(
    <MemoryRouter>
      <GstrExportTab />
    </MemoryRouter>,
  );
}

describe('GstrExportTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom implements neither, and the download path needs both.
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    // A real anchor click would try to navigate in jsdom.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  /**
   * The period is a compliance decision, not a filter: a CA who receives the
   * wrong month files the wrong return.
   */
  it('spells the filing month out rather than showing 2026-07', async () => {
    mount();
    const select = screen.getByLabelText(/filing month/i);
    const months = recentMonths(new Date(), 3);
    expect(select).toHaveTextContent(monthLabel(months[1]));
    expect(select).not.toHaveTextContent(months[1]);
  });

  it('marks the current month as still in progress', async () => {
    mount();
    const user = userEvent.setup();
    const current = recentMonths(new Date(), 1)[0];
    // The closed trigger shows only the selected month; the "still in
    // progress" suffix is on an option, so the list has to actually be open.
    await user.click(screen.getByLabelText(/filing month/i));
    expect(
      await screen.findByRole('option', { name: `${monthLabel(current)} — still in progress` }),
    ).toBeInTheDocument();
  });

  it('defaults to the last complete month, not the one in progress', async () => {
    mount();
    const [current, previous] = recentMonths(new Date(), 2);
    const trigger = screen.getByLabelText(/filing month/i);
    expect(trigger).toHaveTextContent(monthLabel(previous));
    expect(trigger).not.toHaveTextContent(monthLabel(current));
  });

  /** The endpoint renders synchronously — there is no job, so nothing pretends there is. */
  it('says the file arrives in the response, with no job to wait for', async () => {
    mount();
    expect(screen.getByText(/nothing is queued/i)).toBeInTheDocument();
  });

  it('asks the server for exactly the chosen month', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: WITH_ROWS });
    mount();
    const month = recentMonths(new Date(), 2)[1];

    await user.click(screen.getByRole('button', { name: /generate and download/i }));

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        '/superadmin/billing/gstr-export',
        expect.objectContaining({ params: { month } }),
      ),
    );
  });

  it('reports how many document rows came back, and names the file', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: WITH_ROWS });
    mount();
    const month = recentMonths(new Date(), 2)[1];

    await user.click(screen.getByRole('button', { name: /generate and download/i }));

    expect(await screen.findByText(`gstr-${month}.csv downloaded`)).toBeInTheDocument();
    expect(screen.getByText(/2 document rows/)).toBeInTheDocument();
    expect(createObjectURL).toHaveBeenCalled();
  });

  /**
   * A header-only file for a month with nothing invoiced and a header-only file
   * from a misfired query look identical in a downloads folder.
   */
  it('warns when the file it just handed over has no documents in it', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: WITHOUT_ROWS });
    mount();

    await user.click(screen.getByRole('button', { name: /generate and download/i }));

    expect(await screen.findByText(/has no documents/)).toBeInTheDocument();
    expect(screen.getByText(/summary of zeroes/)).toBeInTheDocument();
  });

  it('says nothing was downloaded when the export is refused', async () => {
    const user = userEvent.setup();
    get.mockRejectedValue(
      Object.assign(new Error('failed'), {
        response: { status: 422, data: { detail: 'month must be a calendar month' } },
      }),
    );
    mount();

    await user.click(screen.getByRole('button', { name: /generate and download/i }));

    expect(await screen.findByText(/month must be a calendar month/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing was downloaded/)).toBeInTheDocument();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('clears a previous result when the month changes', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: WITH_ROWS });
    mount();

    await user.click(screen.getByRole('button', { name: /generate and download/i }));
    await screen.findByText(/2 document rows/);

    const months = recentMonths(new Date(), 4);
    await pickOption(user, screen.getByLabelText(/filing month/i), monthLabel(months[2]));
    expect(screen.queryByText(/2 document rows/)).not.toBeInTheDocument();
  });
});
