import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SuppressionsDrawer } from './SuppressionsDrawer';
import { createEmailSuppression, getEmailSuppressions } from '../../services/api';
import type { Bot } from '../../types/domain';

vi.mock('../../services/api', () => ({
  getEmailSuppressions: vi.fn(),
  createEmailSuppression: vi.fn(),
}));

const BOTS: Bot[] = [
  { id: 1, name: 'Acme Support' },
  { id: 2, name: 'Acme Sales' },
];

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    bot_id: 1,
    bot_name: 'Acme Support',
    email: 'priya@infosys.com',
    reason: 'unsubscribe',
    created_at: '2026-08-01T09:00:00Z',
    ...overrides,
  };
}

function renderDrawer(botId: number | null = 1) {
  const client = new QueryClient({
    // The hook keeps its own retry policy (twice, except on a 403), so the only
    // thing worth neutralising here is the wait between attempts.
    defaultOptions: { queries: { retryDelay: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SuppressionsDrawer open onOpenChange={vi.fn()} botId={botId} bots={BOTS} />
    </QueryClientProvider>,
  );
}

function forbidden(): Error {
  return Object.assign(new Error('Bot not found or access denied'), { status: 403 });
}

/**
 * The unsubscribe list, which the console could not see at all until
 * `GET/POST /leads/suppressions` shipped — so a follow-up refused with "this
 * email has unsubscribed" had nowhere to be checked.
 *
 * The behaviour under test is mostly about what the panel *says*. There is
 * deliberately no `DELETE` on this resource: under India's DPDP Act the lawful
 * basis for emailing a visitor is consent, and consent withdrawn is not restored
 * from an admin console. A UI that simply omits a delete button leaves the
 * reader hunting for one and eventually filing a bug, so the absence has to be
 * stated — and adding an address, being permanent, has to be confirmed.
 */
describe('SuppressionsDrawer', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    vi.clearAllMocks();
    user = userEvent.setup();
    vi.mocked(getEmailSuppressions).mockResolvedValue({
      suppressions: [row()],
      total: 1,
      page: 1,
      limit: 25,
    });
  });

  it('says the list cannot be undone, in the place a delete button would be', async () => {
    renderDrawer();

    // A longer wait than the 1s default: this is the first render in the file,
    // so it pays for the drawer's portal, its focus trap and the first query,
    // and it times out on a loaded machine at the default.
    expect(
      await screen.findByText('priya@infosys.com', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    // Stated once, in the panel's own description — not as a four-sentence
    // alert above the list the reader opened the drawer to read.
    expect(screen.getByText(/Nothing can be removed/i)).toBeInTheDocument();

    // The full explanation is where somebody hunting for a delete button looks.
    await user.click(screen.getByRole('button', { name: /Why can.t I remove an address/i }));
    expect(
      await screen.findByText(/Nothing removes one — not this panel and not support/i),
    ).toBeInTheDocument();

    // And there is genuinely no removal control anywhere in the panel. Anchored,
    // so it does not match the disclosure that *explains* why there is none.
    expect(
      screen.queryByRole('button', { name: /^(remove|delete|un-?suppress)/i }),
    ).toBeNull();
  });

  /** The add form is collapsed, so every test that uses it opens it first. */
  async function openAddForm(): Promise<void> {
    await user.click(await screen.findByRole('button', { name: /Record an opt-out/i }));
  }

  it('asks the server for the page it is showing, scoped to the chatbot', async () => {
    renderDrawer(2);

    await waitFor(() =>
      expect(vi.mocked(getEmailSuppressions)).toHaveBeenCalledWith({
        botId: 2,
        page: 1,
        limit: 25,
        search: null,
      }),
    );
  });

  it('separates "nobody has unsubscribed" from "nothing matched your search"', async () => {
    vi.mocked(getEmailSuppressions).mockResolvedValue({
      suppressions: [],
      total: 0,
      page: 1,
      limit: 25,
    });
    renderDrawer();

    expect(await screen.findByText('Nobody has unsubscribed')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: /Search unsubscribed/i }), 'nope');
    expect(await screen.findByText('No address matches')).toBeInTheDocument();
  });

  it('explains a failed load and offers a retry rather than an empty table', async () => {
    vi.mocked(getEmailSuppressions).mockRejectedValue(new Error('Gateway timeout'));
    renderDrawer();

    expect(await screen.findByText('Gateway timeout')).toBeInTheDocument();

    vi.mocked(getEmailSuppressions).mockResolvedValue({
      suppressions: [row()],
      total: 1,
      page: 1,
      limit: 25,
    });
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('priya@infosys.com')).toBeInTheDocument();
  });

  it('treats a 403 as an answer about permission, not as a failure', async () => {
    vi.mocked(getEmailSuppressions).mockRejectedValue(forbidden());
    renderDrawer();

    expect(
      await screen.findByText(/You cannot see this workspace's unsubscribes/i),
    ).toBeInTheDocument();
    // No retry: retrying a permission decision only wastes the reader's time.
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('confirms before it makes a permanent record, and says it is permanent', async () => {
    vi.mocked(createEmailSuppression).mockResolvedValue(row({ id: 12, email: 'sam@acme.com' }));
    renderDrawer();

    await openAddForm();
    await user.type(await screen.findByLabelText(/Email address/i), 'sam@acme.com');
    await user.click(screen.getByRole('button', { name: 'Add to unsubscribes' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/Never email this address again/i);
    expect(dialog).toHaveTextContent(/no way to reverse it/i);
    expect(vi.mocked(createEmailSuppression)).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Add to unsubscribes' }));
    await waitFor(() =>
      expect(vi.mocked(createEmailSuppression)).toHaveBeenCalledWith({
        botId: 1,
        email: 'sam@acme.com',
      }),
    );
    // The outcome is announced. The new row may be on another page, so an
    // emptied form is not feedback anybody can hear.
    const outcome = await screen.findByRole('status');
    expect(outcome).toHaveTextContent('sam@acme.com will not be emailed again by this chatbot.');
  });

  it('rejects an unusable address before asking the server about it', async () => {
    renderDrawer();

    await openAddForm();
    await user.type(await screen.findByLabelText(/Email address/i), 'not-an-address');
    await user.click(screen.getByRole('button', { name: 'Add to unsubscribes' }));

    expect(await screen.findByText(/is not a valid email address/i)).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(vi.mocked(createEmailSuppression)).not.toHaveBeenCalled();
  });

  it('keeps the confirmation open with the reason when the write fails', async () => {
    vi.mocked(createEmailSuppression).mockRejectedValue(
      new Error('That chatbot is not in your workspace.'),
    );
    renderDrawer();

    await openAddForm();
    await user.type(await screen.findByLabelText(/Email address/i), 'sam@acme.com');
    await user.click(screen.getByRole('button', { name: 'Add to unsubscribes' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Add to unsubscribes' }));

    expect(dialog).toHaveTextContent('That chatbot is not in your workspace.');
  });

  it('asks which chatbot when the page is showing all of them', async () => {
    renderDrawer(null);

    // Every chatbot's rows are listed, so the row has to name its chatbot too.
    expect(await screen.findByText('Acme Support')).toBeInTheDocument();

    await openAddForm();
    await user.type(screen.getByLabelText(/Email address/i), 'sam@acme.com');
    await user.click(screen.getByRole('button', { name: 'Add to unsubscribes' }));

    // A suppression on the wrong chatbot silently fails to stop the send the
    // user was trying to stop, so it is refused rather than guessed.
    expect(await screen.findByText('Choose which chatbot this applies to.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await user.selectOptions(screen.getByLabelText(/^Chatbot/), '2');
    await user.click(screen.getByRole('button', { name: 'Add to unsubscribes' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
  });
});
