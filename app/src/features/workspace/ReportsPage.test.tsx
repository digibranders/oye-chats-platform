import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PerAgentReport } from '../../services/api';
import { ReportsPage } from './ReportsPage';

/**
 * The per-agent report is a hand-off artifact: an agency reads these numbers
 * to their own client and downloads the CSV to forward. So the things pinned
 * here are the ones that would make it wrong or unreadable - the totals row
 * being real table structure rather than a body row, the agent name being the
 * row's header so a screen reader labels each figure, the window actually
 * changing what is fetched, and the two "nothing here" states saying different
 * things to a brand-new account and to an established one having a quiet week.
 */

const getPerAgentReport = vi.fn<(days?: number) => Promise<PerAgentReport>>();
const downloadPerAgentReportCsv = vi.fn<(days?: number, name?: string) => Promise<void>>();

vi.mock('../../services/api', () => ({
  getPerAgentReport: (days?: number) => getPerAgentReport(days),
  downloadPerAgentReportCsv: (days?: number, name?: string) => downloadPerAgentReportCsv(days, name),
}));

let agentCount = 2;
vi.mock('../../context/BotContext', () => ({
  useBotContext: () => ({
    bots: Array.from({ length: agentCount }, (_, i) => ({ id: i + 1, name: `Agent ${i + 1}` })),
    loading: false,
  }),
}));

const REPORT: PerAgentReport = {
  since: '2026-07-14T09:00:00+00:00',
  until: '2026-08-13T09:00:00+00:00',
  rows: [
    { bot_id: 1, bot_name: 'Acme Support', credits_spent: 812, conversations: 143, leads: 21 },
    { bot_id: 2, bot_name: 'Globex Sales', credits_spent: 96, conversations: 12, leads: 3 },
  ],
  totals: { credits_spent: 908, conversations: 155, leads: 24 },
};

const EMPTY_REPORT: PerAgentReport = {
  since: REPORT.since,
  until: REPORT.until,
  rows: [],
  totals: { credits_spent: 0, conversations: 0, leads: 0 },
};

function renderPage() {
  return render(
    <MemoryRouter>
      <ReportsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  agentCount = 2;
  getPerAgentReport.mockReset().mockResolvedValue(REPORT);
  downloadPerAgentReportCsv.mockReset().mockResolvedValue(undefined);
});

describe('the report table', () => {
  it('gives every figure a row header and a column header', async () => {
    renderPage();
    const table = await screen.findByRole('table');

    // Column headers, in the order the CSV writes them.
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent?.trim()),
    ).toEqual(['Agent', 'Conversations', 'Leads', 'Credits used']);

    // Each agent name is the row's HEADER, not just another cell - that is
    // what makes a screen reader announce "Acme Support, Leads, 21".
    const nameCell = within(table).getByRole('rowheader', { name: 'Acme Support' });
    expect(nameCell.tagName).toBe('TH');
    expect(nameCell).toHaveAttribute('scope', 'row');
  });

  it('renders one row per agent with all four metrics', async () => {
    renderPage();
    const table = await screen.findByRole('table');
    const body = table.querySelector('tbody');
    expect(body).not.toBeNull();

    const rows = within(body as HTMLElement).getAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Acme Support');
    expect(rows[0].textContent).toContain('143');
    expect(rows[0].textContent).toContain('21');
    expect(rows[0].textContent).toContain('812');
  });

  it('puts the account totals in a real <tfoot>, not in the body', async () => {
    renderPage();
    const table = await screen.findByRole('table');

    const foot = table.querySelector('tfoot');
    expect(foot).not.toBeNull();
    const totals = within(foot as HTMLElement).getByRole('row');
    expect(totals.textContent).toContain('All agents');
    // Server-supplied totals, rendered verbatim - never re-summed client-side,
    // or the page and the CSV could quote different numbers.
    expect(totals.textContent).toContain('155');
    expect(totals.textContent).toContain('24');
    expect(totals.textContent).toContain('908');

    // The totals must not also appear as a body row (an agent genuinely named
    // "All agents" is the only thing that should ever match in <tbody>).
    const body = table.querySelector('tbody') as HTMLElement;
    expect(within(body).queryByRole('rowheader', { name: 'All agents' })).toBeNull();
  });
});

describe('the range selector', () => {
  it('is a radio group with the active window checked', async () => {
    renderPage();
    await screen.findByRole('table');

    const group = screen.getByRole('radiogroup', { name: 'Reporting window' });
    const options = within(group).getAllByRole('radio');
    expect(options.map((option) => option.textContent)).toEqual(['7 days', '30 days', '90 days']);
    expect(within(group).getByRole('radio', { name: '30 days' })).toBeChecked();
  });

  it('re-fetches with the selected window', async () => {
    renderPage();
    await screen.findByRole('table');
    expect(getPerAgentReport).toHaveBeenCalledWith(30);

    fireEvent.click(screen.getByRole('radio', { name: '7 days' }));

    await waitFor(() => expect(getPerAgentReport).toHaveBeenCalledWith(7));
    expect(screen.getByRole('radio', { name: '7 days' })).toBeChecked();
  });
});

describe('the CSV download', () => {
  it('exports the window on screen, under the server`s dated filename', async () => {
    renderPage();
    await screen.findByRole('table');

    fireEvent.click(screen.getByRole('button', { name: /download csv/i }));

    await waitFor(() =>
      expect(downloadPerAgentReportCsv).toHaveBeenCalledWith(
        30,
        'oyechats-report-2026-07-14-to-2026-08-13.csv',
      ),
    );
  });

  it('is disabled when there is nothing to export', async () => {
    getPerAgentReport.mockResolvedValue(EMPTY_REPORT);
    renderPage();

    // A header-only CSV reads as a broken download rather than a quiet month.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /download csv/i })).toBeDisabled(),
    );
  });

  it('surfaces a failed export without losing the table', async () => {
    downloadPerAgentReportCsv.mockRejectedValue(new Error('Network unreachable'));
    renderPage();
    await screen.findByRole('table');

    fireEvent.click(screen.getByRole('button', { name: /download csv/i }));

    expect(await screen.findByText('Network unreachable')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});

describe('empty and error states', () => {
  it('sends a brand-new account to create its first chatbot', async () => {
    agentCount = 0;
    getPerAgentReport.mockResolvedValue(EMPTY_REPORT);
    renderPage();

    expect(await screen.findByText('No chatbots to report on yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /create an ai chatbot/i })).toHaveAttribute(
      'href',
      '/agents',
    );
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('offers an established account a wider window instead', async () => {
    getPerAgentReport.mockResolvedValue(EMPTY_REPORT);
    renderPage();

    // Two live agents and a quiet month must NOT be told to create a chatbot.
    expect(await screen.findByText('No activity in the last 30 days')).toBeInTheDocument();
    expect(screen.queryByText('No chatbots to report on yet')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /show the last 90 days/i }));
    await waitFor(() => expect(getPerAgentReport).toHaveBeenCalledWith(90));
  });

  it('offers a retry when the report fails to load', async () => {
    getPerAgentReport.mockRejectedValueOnce(new Error('Report service is down'));
    renderPage();

    expect(await screen.findByText('Report service is down')).toBeInTheDocument();

    getPerAgentReport.mockResolvedValue(REPORT);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });
});
