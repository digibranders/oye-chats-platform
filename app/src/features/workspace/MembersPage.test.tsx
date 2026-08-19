import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The team page's contract, as the audit defined it.
 *
 * Seven destructive or role-changing actions shipped here with no confirmation
 * at all — including promoting a teammate to Owner, which hands over billing
 * and the API key. An owner could join their own workspace's live chat and
 * never leave it, because `removeSelfAsOperator` existed in the API client and
 * nothing called it. And the four states were one blank panel.
 *
 * So what is pinned is: every dangerous action goes through a confirmation that
 * names the consequence, the confirmation's cancel actually cancels, the leave
 * path exists and calls the right endpoint, and each of loading, error,
 * forbidden and empty says a different thing.
 */

const api = vi.hoisted(() => ({
  getOperators: vi.fn(),
  getDepartments: vi.fn(),
  listOperatorInvites: vi.fn(),
  getCurrentUser: vi.fn(),
  deleteOperator: vi.fn(),
  updateOperator: vi.fn(),
  createOperatorInvite: vi.fn(),
  resendOperatorInvite: vi.fn(),
  revokeOperatorInvite: vi.fn(),
  addSelfAsOperator: vi.fn(),
  removeSelfAsOperator: vi.fn(),
  createDepartment: vi.fn(),
  updateDepartment: vi.fn(),
  deleteDepartment: vi.fn(),
}));
vi.mock('../../services/api', () => api);

const entitlements = vi.hoisted(() => ({
  isFree: false,
  limitFor: ((_key: string) => 5) as (key: string) => number,
  hasFeature: ((_key: string) => true) as (key: string) => boolean,
}));
vi.mock('../../hooks/useEntitlements', () => ({ useEntitlements: () => entitlements }));

const workspace = vi.hoisted(() => ({ currentRole: 'owner' as string | null }));
vi.mock('../../context/WorkspaceContext', () => ({ useWorkspace: () => workspace }));

vi.mock('../../context/BotContext', () => ({
  useBotContext: () => ({
    bots: [{ id: 1, name: 'Acme Support' }],
    selectedBot: { id: 1, name: 'Acme Support' },
    loading: false,
    error: null,
  }),
}));

const { MembersPage } = await import('./MembersPage');

// A menu, a dialog and a mutation sit comfortably inside the default 5s budget
// in isolation, and comfortably outside it when the whole suite runs in
// parallel on a loaded machine. This is a statement about the runner, not about
// what is being asserted — the assertions themselves all settle in milliseconds.
vi.setConfig({ testTimeout: 20_000 });

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: 'Priya Raman',
    email: 'priya@acme.com',
    role: 'operator',
    bot_id: 1,
    department_id: null,
    is_online: false,
    is_active: true,
    max_concurrent_chats: 3,
    active_chats: 0,
    linked_client_id: null,
    ...overrides,
  };
}

function renderPage(entry = '/settings/team') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/settings/team" element={<MembersPage />} />
          <Route path="/billing" element={<p>Billing</p>} />
          <Route path="/account" element={<p>Account</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  entitlements.isFree = false;
  entitlements.limitFor = () => 5;
  entitlements.hasFeature = () => true;
  workspace.currentRole = 'owner';
  api.getOperators.mockResolvedValue({ operators: [member()] });
  api.getDepartments.mockResolvedValue({ departments: [] });
  api.listOperatorInvites.mockResolvedValue([]);
  api.getCurrentUser.mockResolvedValue({ id: 42, email: 'owner@acme.com', kind: 'client' });
  api.deleteOperator.mockResolvedValue({ success: true });
  api.updateOperator.mockResolvedValue({ success: true });
  api.removeSelfAsOperator.mockResolvedValue(true);
  api.addSelfAsOperator.mockResolvedValue({ operator_id: 9 });
  api.revokeOperatorInvite.mockResolvedValue(true);
  api.deleteDepartment.mockResolvedValue({ success: true });
});

describe('MembersPage — the four states', () => {
  it('shows a loading placeholder rather than an empty roster', () => {
    api.getOperators.mockReturnValue(new Promise(() => {}));
    api.getDepartments.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(document.querySelector('[aria-busy]')).not.toBeNull();
  });

  it('says the load failed, and offers the way back', async () => {
    api.getOperators.mockRejectedValue(new Error('network is down'));
    renderPage();
    expect(await screen.findByText('We could not load your team')).toBeInTheDocument();
    expect(screen.getByText('network is down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('answers a plan boundary with an upgrade path, not with an error', async () => {
    entitlements.isFree = true;
    renderPage();
    expect(
      await screen.findByText('Your plan does not include a team'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /see plans/i })).toBeInTheDocument();
    // A Free workspace must not even ask for the roster.
    expect(api.getOperators).not.toHaveBeenCalled();
  });

  it('tells an operator seat this is not theirs to manage, and where theirs is', async () => {
    workspace.currentRole = 'operator';
    renderPage();
    expect(
      await screen.findByText('Only owners and admins can manage the team'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to your account/i })).toBeInTheDocument();
  });

  it('distinguishes an empty roster from a failed one, and offers the way in', async () => {
    api.getOperators.mockResolvedValue({ operators: [] });
    renderPage();
    expect(await screen.findByText('Nobody on the roster yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /invite a teammate/i })).toBeInTheDocument();
  });
});

describe('MembersPage — destructive actions confirm', () => {
  it('will not remove a teammate without a confirmation that states the cost', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Priya Raman');

    await user.click(screen.getByRole('button', { name: /actions for priya raman/i }));
    await user.click(await screen.findByRole('menuitem', { name: /remove from team/i }));

    const dialog = await screen.findByRole('alertdialog');
    // The consequence, not "this cannot be undone".
    expect(within(dialog).getByText(/goes back to the chatbot/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/seat is freed/i)).toBeInTheDocument();
    expect(api.deleteOperator).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /remove from team/i }));
    await waitFor(() => expect(api.deleteOperator).toHaveBeenCalledWith(7));
  });

  it('cancelling the confirmation leaves the teammate alone', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Priya Raman');

    await user.click(screen.getByRole('button', { name: /actions for priya raman/i }));
    await user.click(await screen.findByRole('menuitem', { name: /remove from team/i }));

    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(api.deleteOperator).not.toHaveBeenCalled();
  });

  it('never uses a typed phrase for a routine removal', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Priya Raman');
    await user.click(screen.getByRole('button', { name: /actions for priya raman/i }));
    await user.click(await screen.findByRole('menuitem', { name: /remove from team/i }));

    const dialog = await screen.findByRole('alertdialog');
    // `confirmPhrase` is reserved for work that cannot be recreated. Asking for
    // it here would train people to type past it.
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('confirms before revoking an invitation, and says what the link does after', async () => {
    const user = userEvent.setup();
    api.listOperatorInvites.mockResolvedValue([
      {
        id: 3,
        email: 'new@acme.com',
        role: 'operator',
        bot_id: 1,
        status: 'pending',
        expires_at: '2099-01-01T00:00:00Z',
        invited_by_name: 'Owner',
      },
    ]);
    renderPage('/settings/team?tab=invitations');
    await screen.findByText('new@acme.com');

    await user.click(screen.getByRole('button', { name: /revoke the invitation/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/stops working/i)).toBeInTheDocument();
    expect(api.revokeOperatorInvite).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /revoke invitation/i }));
    await waitFor(() => expect(api.revokeOperatorInvite).toHaveBeenCalledWith(3));
  });

  it('confirms before deleting a department, naming what happens to its members', async () => {
    const user = userEvent.setup();
    api.getDepartments.mockResolvedValue({
      departments: [{ id: 5, name: 'Billing', description: null, business_hours: null }],
    });
    renderPage('/settings/team?tab=departments');
    await screen.findByRole('button', { name: /delete the billing department/i });

    await user.click(screen.getByRole('button', { name: /delete the billing department/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/stays on the team but loses their grouping/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /delete department/i }));
    await waitFor(() => expect(api.deleteDepartment).toHaveBeenCalledWith(5));
  });
});

describe('MembersPage — the owner’s own seat', () => {
  it('offers a way in, and says it costs a seat before it is spent', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('You are not taking live chats');

    await user.click(screen.getByRole('button', { name: /join live chat/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/takes one of your plan's seats/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /join live chat/i }));
    await waitFor(() => expect(api.addSelfAsOperator).toHaveBeenCalledWith(1));
  });

  it('offers a way out — the ledger item that had no consumer at all', async () => {
    const user = userEvent.setup();
    api.getOperators.mockResolvedValue({
      operators: [member({ id: 9, name: 'You', role: 'owner', linked_client_id: 42 })],
    });
    renderPage();
    await screen.findByText('You are taking live chats');

    await user.click(screen.getByRole('button', { name: /leave live chat/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/seat is freed/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/still own the workspace/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /leave live chat/i }));
    await waitFor(() => expect(api.removeSelfAsOperator).toHaveBeenCalled());
  });

  it('will not offer the owner a seat there is no room for', async () => {
    entitlements.limitFor = () => 1;
    renderPage();
    await screen.findByText('You are not taking live chats');
    expect(screen.getByRole('button', { name: /join live chat/i })).toBeDisabled();
  });
});

describe('MembersPage — tabs live in the URL', () => {
  it('opens the tab the URL names, so a link can point at one', async () => {
    api.getDepartments.mockResolvedValue({
      departments: [{ id: 5, name: 'Billing', description: null, business_hours: null }],
    });
    renderPage('/settings/team?tab=departments');
    // Named by its own edit control, because "Billing" is also the credits link
    // in the seat card above — a bare text match would find both.
    expect(
      await screen.findByRole('button', { name: /delete the billing department/i }),
    ).toBeInTheDocument();
  });

  it('is reachable by keyboard from the tab row to the table', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Priya Raman');

    const people = screen.getByRole('tab', { name: /people/i });
    people.focus();
    expect(people).toHaveFocus();
    // Arrow moves focus without selecting: a tab row that selects on focus
    // makes a keyboard user load every panel on the way past.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /invitations/i })).toHaveFocus();
    expect(screen.getByRole('tab', { name: /people/i })).toHaveAttribute('aria-selected', 'true');
  });
});
