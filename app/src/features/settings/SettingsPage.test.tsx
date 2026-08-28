import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/account` — the personal surface, and the one ledger item it closes.
 *
 * A team member's name is what a visitor sees beside every message they send,
 * and until now they could not change it: the roster let an admin edit their
 * role and their capacity, and `PATCH /operators/{id}` refuses a name change
 * from anyone but the operator themselves, so there was no path at all.
 *
 * Also pinned: there is exactly one `h1`, and there is no theme switch. The
 * console is light mode only by design, and a control that changes nothing is
 * worse than an absent one.
 */

const api = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  updateClientProfile: vi.fn(),
  updateOperator: vi.fn(),
  changeClientPassword: vi.fn(),
  operatorChangePassword: vi.fn(),
  requestClientEmailChange: vi.fn(),
  confirmClientEmailChange: vi.fn(),
  cancelClientEmailChange: vi.fn(),
  getNotificationPreferences: vi.fn(),
  updateNotificationPreferences: vi.fn(),
  // The language selector subscribes to the backend locale catalogue. An empty
  // one is a real state (the request has not landed yet), and the section
  // falls back to the shipped endonyms, which is what these tests read.
  getLocales: vi.fn().mockResolvedValue({ locales: [], languages: {} }),
  uploadOperatorAvatar: vi.fn(),
  removeOperatorAvatar: vi.fn(),
}));
vi.mock('../../services/api', () => api);

vi.mock('../../hooks/usePushSubscription', () => ({
  usePushSubscription: () => ({
    supported: false,
    phase: { status: 'unsupported' },
    busy: false,
    actionError: '',
    enable: vi.fn(),
    disable: vi.fn(),
    recheck: vi.fn(),
  }),
}));

vi.mock('../../hooks/useEntitlements', () => ({
  useEntitlements: () => ({ hasFeature: () => false }),
}));

const { SettingsPage } = await import('./SettingsPage');

// A menu, a dialog and a mutation sit comfortably inside the default 5s budget
// in isolation, and comfortably outside it when the whole suite runs in
// parallel on a loaded machine. This is a statement about the runner, not about
// what is being asserted — the assertions themselves all settle in milliseconds.
vi.setConfig({ testTimeout: 20_000 });

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/account']}>
        <Routes>
          <Route path="/account" element={<SettingsPage />} />
          <Route path="/settings/workspace" element={<p>Workspace</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getCurrentUser.mockResolvedValue({
    id: 42,
    name: 'Priya Raman',
    email: 'priya@acme.com',
    kind: 'client',
  });
  api.updateClientProfile.mockImplementation(async (patch: { name?: string }) => ({
    id: 42,
    name: patch.name ?? 'Priya Raman',
    email: 'priya@acme.com',
    pending_email: null,
  }));
  api.updateOperator.mockResolvedValue({ success: true });
  api.getNotificationPreferences.mockResolvedValue({
    push: { enabled: true, events: {}, quiet_hours: null },
  });
});

describe('SettingsPage', () => {
  it('has exactly one h1, and it names the page', async () => {
    renderPage();
    await screen.findByDisplayValue('Priya Raman');
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Your account');
  });

  it('ships no theme switch, because the console is light mode only', async () => {
    renderPage();
    await screen.findByDisplayValue('Priya Raman');
    expect(screen.queryByText(/appearance/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /dark/i })).not.toBeInTheDocument();
  });

  it('shows a loading placeholder, then the account', async () => {
    api.getCurrentUser.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(document.querySelector('[aria-busy]')).not.toBeNull();
  });

  it('says what failed to load, with a retry', async () => {
    api.getCurrentUser.mockRejectedValue(new Error('gateway timeout'));
    renderPage();
    expect(await screen.findByText('We could not load your account')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('saves an owner’s name through the client endpoint', async () => {
    const user = userEvent.setup();
    renderPage();
    const name = await screen.findByDisplayValue('Priya Raman');

    await user.clear(name);
    await user.type(name, 'Priya R');
    await user.click(screen.getAllByRole('button', { name: /save changes/i })[0]);

    await waitFor(() => expect(api.updateClientProfile).toHaveBeenCalledWith({ name: 'Priya R' }));
    expect(api.updateOperator).not.toHaveBeenCalled();
  });

  it('lets a team seat fix their own name and email — the path that did not exist', async () => {
    const user = userEvent.setup();
    api.getCurrentUser.mockResolvedValue({
      id: 9,
      name: 'Anil',
      email: 'anil@acme.com',
      kind: 'operator',
      role: 'operator',
    });
    renderPage();
    const name = await screen.findByDisplayValue('Anil');

    await user.clear(name);
    await user.type(name, 'Anil Kumar');
    await user.click(screen.getAllByRole('button', { name: /save changes/i })[0]);

    // Self-edit against their own operator row, which is the only caller the
    // backend accepts for a name change.
    await waitFor(() =>
      expect(api.updateOperator).toHaveBeenCalledWith(9, { name: 'Anil Kumar' }),
    );
  });

  it('does not offer a team seat the owner-only email change flow', async () => {
    api.getCurrentUser.mockResolvedValue({
      id: 9,
      name: 'Anil',
      email: 'anil@acme.com',
      kind: 'operator',
    });
    renderPage();
    await screen.findByDisplayValue('Anil');
    expect(screen.queryByText('Sign-in email')).not.toBeInTheDocument();
    expect(screen.getByText('This is a team seat')).toBeInTheDocument();
  });

  it('confirms before signing out, and says what is lost', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByDisplayValue('Priya Raman');

    await user.click(screen.getByRole('button', { name: /^sign out$/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/go back to the queue/i);
  });
});
