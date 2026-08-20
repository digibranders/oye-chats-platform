import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Operator } from '../../types/domain';

/**
 * Changing what somebody is allowed to do.
 *
 * The console this replaced offered a bare three-item `<select>` and saved on
 * click. Promoting a teammate to Owner — which hands over billing, the payment
 * method and the workspace API key, and lets them remove the person doing the
 * promoting — was one unguarded change of a dropdown.
 */

const api = vi.hoisted(() => ({ updateOperator: vi.fn() }));
vi.mock('../../services/api', () => api);

const { MemberDialog } = await import('./MemberDialog');

// A menu, a dialog and a mutation sit comfortably inside the default 5s budget
// in isolation, and comfortably outside it when the whole suite runs in
// parallel on a loaded machine. This is a statement about the runner, not about
// what is being asserted — the assertions themselves all settle in milliseconds.
vi.setConfig({ testTimeout: 20_000 });

const MEMBER: Operator = {
  id: 7,
  name: 'Priya Raman',
  email: 'priya@acme.com',
  role: 'operator',
  bot_id: 1,
  department_id: null,
  is_online: false,
  is_active: true,
  max_concurrent_chats: 3,
  linked_client_id: null,
};

function renderDialog(props: Partial<Parameters<typeof MemberDialog>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MemberDialog
          open
          onOpenChange={() => {}}
          member={MEMBER}
          departments={[{ id: 5, name: 'Billing' }]}
          callerRole="owner"
          isSelf={false}
          onSaved={() => {}}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.updateOperator.mockResolvedValue({ success: true });
});

describe('MemberDialog', () => {
  it('says what every role can do, without having to choose one to find out', async () => {
    const user = userEvent.setup();
    renderDialog();

    // All three summaries are on screen at once, so they can be compared before
    // a choice is made rather than read one at a time by changing the value.
    expect(screen.getByText(/Answers conversations\./i)).toBeInTheDocument();
    expect(screen.getByText(/plus managing the team and the chatbots/i)).toBeInTheDocument();
    expect(screen.getByText(/Full control, including billing/i)).toBeInTheDocument();

    expect(screen.getByRole('radio', { name: 'Operator' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: 'Admin' }));
    expect(screen.getByRole('radio', { name: 'Admin' })).toHaveAttribute('aria-checked', 'true');
  });

  it('will not change a role without a confirmation that names the consequence', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('radio', { name: 'Owner' }));
    await user.click(screen.getByRole('button', { name: /review and save/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/billing/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/rotate the workspace API key/i)).toBeInTheDocument();
    expect(api.updateOperator).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /change role/i }));
    await waitFor(() =>
      expect(api.updateOperator).toHaveBeenCalledWith(7, {
        role: 'owner',
        department_id: null,
        max_concurrent_chats: 3,
      }),
    );
  });

  it('cancelling the confirmation leaves the role where it was', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('radio', { name: 'Owner' }));
    await user.click(screen.getByRole('button', { name: /review and save/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(api.updateOperator).not.toHaveBeenCalled();
  });

  it('saves a department or capacity change without a confirmation — it is not one', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.selectOptions(screen.getByLabelText(/department/i), '5');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(api.updateOperator).toHaveBeenCalledWith(7, {
        role: 'operator',
        department_id: 5,
        max_concurrent_chats: 3,
      }),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('refuses a capacity that would make them unroutable, at the field', async () => {
    const user = userEvent.setup();
    renderDialog();

    const capacity = screen.getByLabelText(/live chats at once/i);
    await user.clear(capacity);
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/Enter how many chats/i)).toBeInTheDocument();
    expect(api.updateOperator).not.toHaveBeenCalled();
  });

  it('does not offer Owner to an admin, who cannot grant it', () => {
    renderDialog({ callerRole: 'admin' });
    const options = within(screen.getByRole('radiogroup', { name: /role/i })).getAllByRole('radio');
    expect(options.map((option) => option.getAttribute('aria-label'))).toEqual([
      'Operator',
      'Admin',
    ]);
  });

  it('shows the email as read-only, because the server refuses an admin changing it', () => {
    renderDialog();
    const email = screen.getByLabelText(/^email/i);
    expect(email).toBeDisabled();
    expect(screen.getByText(/Only this person can change their own email/i)).toBeInTheDocument();
  });

  it('points the signed-in person at their own account for their name', () => {
    renderDialog({ isSelf: true });
    expect(screen.getByRole('link', { name: /edit your name and email/i })).toHaveAttribute(
      'href',
      '/account',
    );
  });
});
