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
  updateBot: vi.fn(),
  getCreditBalance: vi.fn(),
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

/**
 * `GET /credits/balance` with a ledger of its own for chatbot 1.
 *
 * The per-chatbot pool is where this chatbot's own plan ceilings live. It is
 * the only per-chatbot seat limit the console holds: `useEntitlements` reports
 * the highest-priced plan across the whole workspace.
 */
function balanceWithSeatCeiling(operators: number) {
  return {
    plan: 0,
    topup: 0,
    total: 0,
    monthly_grant: 0,
    plan_granted: 0,
    costs: {},
    usage: {},
    currency: 'INR',
    account_pool_bot_count: 0,
    bots: [
      {
        bot_id: 1,
        bot_name: 'Acme Support',
        plan_name: 'Starter',
        plan: 0,
        topup: 0,
        total: 0,
        monthly_grant: 0,
        plan_granted: 0,
        usage: {},
        limits: { operators },
        limit_usage: { operators: 1, documents: 0, leads: 0 },
      },
    ],
  };
}

/** No chatbot carries its own ledger, so there is no per-chatbot ceiling to read. */
const BALANCE_WITHOUT_POOLS = {
  plan: 0,
  topup: 0,
  total: 0,
  monthly_grant: 0,
  plan_granted: 0,
  costs: {},
  usage: {},
  currency: 'INR',
  bots: [],
  account_pool_bot_count: 1,
};

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
  api.updateBot.mockResolvedValue({ message: 'ok' });
  api.getCreditBalance.mockResolvedValue(BALANCE_WITHOUT_POOLS);
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
    expect(await screen.findByText('Your plan does not include a team')).toBeInTheDocument();
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
    expect(within(dialog).getByText(/go back to the chatbot/i)).toBeInTheDocument();
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

    await user.click(
      screen.getByRole('button', { name: /actions for the invitation to new@acme.com/i }),
    );
    await user.click(await screen.findByRole('menuitem', { name: /revoke the invitation/i }));
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
    await user.click(
      await screen.findByRole('button', { name: /actions for the billing department/i }),
    );
    await user.click(await screen.findByRole('menuitem', { name: /delete department/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/stay on the team but lose their grouping/i),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /delete department/i }));
    await waitFor(() => expect(api.deleteDepartment).toHaveBeenCalledWith(5));
  });
});

describe('MembersPage — deactivating a teammate', () => {
  /**
   * `PATCH /operators/{id}` takes `is_active` now. It is deliberately not the
   * same act as `DELETE`: deleting the row nulls `assigned_operator_id` on
   * every historical chat, erasing who handled it, while deactivating frees the
   * seat and leaves the audit trail intact. Both need a confirmation, and they
   * need different words.
   */
  it('says what deactivating costs and what it preserves', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Priya Raman');

    await user.click(screen.getByRole('button', { name: /actions for priya raman/i }));
    await user.click(await screen.findByRole('menuitem', { name: /deactivate/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/go back to the queue/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/seat is freed/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Nothing is deleted/i)).toBeInTheDocument();
    expect(api.updateOperator).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /^deactivate$/i }));
    await waitFor(() => expect(api.updateOperator).toHaveBeenCalledWith(7, { is_active: false }));
  });

  it('offers reactivation, not deactivation, on somebody already switched off', async () => {
    const user = userEvent.setup();
    api.getOperators.mockResolvedValue({ operators: [member({ is_active: false })] });
    renderPage();
    await screen.findByText('Priya Raman');

    // The roster says the state in a word, because a greyed row is not a signal.
    expect(screen.getByText('Deactivated')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /actions for priya raman/i }));
    expect(await screen.findByRole('menuitem', { name: /reactivate/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /^deactivate/i })).not.toBeInTheDocument();
  });

  /**
   * The direction that can fail. Reactivating consumes a seat, and
   * `invite_service._require_seat_available` refuses when the plan has none —
   * so the roster must not be flipped in anticipation of a yes.
   */
  it('shows the seat refusal rather than pretending the teammate is back', async () => {
    const user = userEvent.setup();
    api.getOperators.mockResolvedValue({ operators: [member({ is_active: false })] });
    api.updateOperator.mockRejectedValue(
      Object.assign(new Error('This chatbot has no operator seats left on its plan.'), {
        status: 403,
      }),
    );
    renderPage();
    await screen.findByText('Priya Raman');

    await user.click(screen.getByRole('button', { name: /actions for priya raman/i }));
    await user.click(await screen.findByRole('menuitem', { name: /reactivate/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^reactivate$/i }));

    expect(
      await within(dialog).findByText('This chatbot has no operator seats left on its plan.'),
    ).toBeInTheDocument();
    // Still deactivated, still refusable, and the dialog is still dismissible.
    expect(screen.getByText('Deactivated')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeEnabled();
  });

  it('warns that reactivating takes a seat before it asks the server for one', async () => {
    const user = userEvent.setup();
    api.getOperators.mockResolvedValue({ operators: [member({ is_active: false })] });
    renderPage();
    await screen.findByText('Priya Raman');

    await user.click(screen.getByRole('button', { name: /actions for priya raman/i }));
    await user.click(await screen.findByRole('menuitem', { name: /reactivate/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/takes one of this chatbot’s seats/i)).toBeInTheDocument();
    expect(api.updateOperator).not.toHaveBeenCalled();
  });

  /**
   * The one row that must not offer it: the server refuses self-deactivation
   * outright, so offering the action would be an invitation to a 400.
   */
  it('never offers to deactivate the signed-in owner’s own seat', async () => {
    const user = userEvent.setup();
    api.getOperators.mockResolvedValue({
      operators: [member({ id: 9, name: 'Owner', linked_client_id: 42 })],
    });
    renderPage();
    await screen.findByText('Owner');

    await user.click(screen.getByRole('button', { name: /actions for owner/i }));
    expect(await screen.findByRole('menuitem', { name: /leave live chat/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /deactivate/i })).not.toBeInTheDocument();
  });
});

/**
 * The owner's own state is read off the button, not off a dot.
 *
 * These three used to gate on the text "You are / are not taking live chats",
 * which was the `sr-only` label of a bare `StatusDot` in the toolbar — an 8px
 * disc whose sentence nobody sighted could read. The button beside it says
 * which state you are in, in words, to everyone; it is now the only statement
 * of it, so it is what these assertions read.
 */
describe('MembersPage — the owner’s own seat', () => {
  it('offers a way in, and says it costs a seat before it is spent', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /join live chat/i });

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
    await screen.findByRole('button', { name: /leave live chat/i });

    await user.click(screen.getByRole('button', { name: /leave live chat/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/seat is freed/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/still own the workspace/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /leave live chat/i }));
    await waitFor(() => expect(api.removeSelfAsOperator).toHaveBeenCalled());
  });

  it('will not offer the owner a seat this chatbot has no room for', async () => {
    // One active operator against this chatbot's own ceiling of one.
    api.getCreditBalance.mockResolvedValue(balanceWithSeatCeiling(1));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /join live chat/i })).toBeDisabled(),
    );
  });
});

/**
 * Which plan's seats the meter is counting against.
 *
 * `useEntitlements().limits.operators` is the highest-priced plan across the
 * WORKSPACE, and the roster below it is one chatbot's. So a Starter chatbot
 * sitting beside a Professional one read "1 of 10 seats" with Invite and Join
 * live chat both live, and the server then refused the invite with a message
 * this file already pins. The per-chatbot ceiling is in the balance payload.
 */
describe('MembersPage: whose seats the meter counts', () => {
  it('meters this chatbot’s roster against this chatbot’s plan', async () => {
    entitlements.limitFor = () => 10; // The workspace's best plan.
    api.getCreditBalance.mockResolvedValue(balanceWithSeatCeiling(2));
    renderPage();

    const meter = await screen.findByRole('meter', { name: /seats on this chatbot/i });
    await waitFor(() => expect(meter.getAttribute('aria-valuetext')).toContain('1 of 2 used'));
    // One filled of two: there is still room, so the way in stays open.
    expect(screen.getByRole('button', { name: /join live chat/i })).toBeEnabled();
  });

  it('says so when the only figure it has is the workspace-wide one', async () => {
    // A chatbot with no ledger of its own has no ceiling to read here.
    entitlements.limitFor = () => 10;
    renderPage();

    expect(
      await screen.findByRole('meter', { name: /seats across this workspace/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Seats on this chatbot')).toBeNull();
  });

  it('never closes the door on a workspace-wide figure', async () => {
    // The account limit is reached, but it is the wrong plan's ceiling to
    // enforce against one chatbot: the server decides, and it may well say yes.
    entitlements.limitFor = () => 1;
    renderPage();

    await screen.findByRole('meter', { name: /seats across this workspace/i });
    expect(screen.getByRole('button', { name: /join live chat/i })).toBeEnabled();
  });
});

describe('MembersPage: tabs live in the URL', () => {
  it('opens the tab the URL names, so a link can point at one', async () => {
    api.getDepartments.mockResolvedValue({
      departments: [{ id: 5, name: 'Billing', description: null, business_hours: null }],
    });
    renderPage('/settings/team?tab=departments');
    // Named by its own row menu rather than by a bare text match: the tab row
    // above also carries the word.
    expect(
      await screen.findByRole('button', { name: /actions for the billing department/i }),
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

describe('MembersPage — routing', () => {
  it('exposes the queue settings that had no control anywhere', async () => {
    renderPage('/settings/team?tab=routing');
    expect(await screen.findByText('Waiting and routing')).toBeInTheDocument();
    expect(screen.getByLabelText(/accept timeout/i)).toHaveValue('120');
    expect(screen.getByLabelText(/queue length/i)).toHaveValue('10');
    // The fourth timer. `UpdateBotRequest` accepts it now, and
    // `handle_visitor_disconnect` really does read the column, so this page
    // owns it rather than the "not configurable" list on Behaviour.
    expect(screen.getByLabelText(/hold a dropped visitor/i)).toHaveValue('120');
  });

  it('saves the visitor grace period with the rest of the queue', async () => {
    const user = userEvent.setup();
    renderPage('/settings/team?tab=routing');
    const field = await screen.findByLabelText(/hold a dropped visitor/i);

    await user.clear(field);
    await user.type(field, '45');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(api.updateBot).toHaveBeenCalledWith(1, {
        operator_timeout_seconds: 120,
        live_chat_queue_timeout_seconds: 20,
        live_chat_max_queue_size: 10,
        visitor_disconnect_timeout: 45,
      }),
    );
  });

  it('refuses a grace period the API would refuse, at the field', async () => {
    const user = userEvent.setup();
    renderPage('/settings/team?tab=routing');
    const field = await screen.findByLabelText(/hold a dropped visitor/i);

    await user.clear(field);
    await user.type(field, '4');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/At least 5 seconds/i)).toBeInTheDocument();
    expect(api.updateBot).not.toHaveBeenCalled();
  });

  it('refuses a value the API would refuse, at the field', async () => {
    const user = userEvent.setup();
    renderPage('/settings/team?tab=routing');
    const field = await screen.findByLabelText(/queue length/i);

    await user.clear(field);
    await user.type(field, '0');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/At least one, or nobody can ever wait/i)).toBeInTheDocument();
  });
});
