import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The edit contract, on the page that defines it for the rest of settings.
 *
 * The version this replaces hid the fields behind an "Edit details" button, so
 * the page could not tell you whether anything was unsaved — and there was no
 * way to discard. What is pinned here is the whole contract: the state is
 * always visible, the changed fields are named, discard restores, and a failed
 * validation lands on the field rather than in a shared banner.
 */

const api = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  updateClientProfile: vi.fn(),
}));
vi.mock('../../services/api', () => api);

const workspace = vi.hoisted(() => ({
  currentWorkspaceId: 42,
  currentRole: 'owner' as string | null,
  workspaces: [{ id: 42, name: 'Acme' }],
  refresh: vi.fn(),
}));
vi.mock('../../context/WorkspaceContext', () => ({ useWorkspace: () => workspace }));

vi.mock('../../context/BotContext', () => ({
  useBotContext: () => ({ bots: [{ id: 1, name: 'Acme Support' }] }),
}));

vi.mock('../../hooks/useEntitlements', () => ({
  useEntitlements: () => ({ planName: 'Standard', planSlug: 'standard', limitFor: () => 3 }),
}));

const { GeneralPage } = await import('./GeneralPage');

// A menu, a dialog and a mutation sit comfortably inside the default 5s budget
// in isolation, and comfortably outside it when the whole suite runs in
// parallel on a loaded machine. This is a statement about the runner, not about
// what is being asserted — the assertions themselves all settle in milliseconds.
vi.setConfig({ testTimeout: 20_000 });

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings/workspace']}>
        <Routes>
          <Route path="/settings/workspace" element={<GeneralPage />} />
          <Route path="/account" element={<p>Account</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  workspace.currentRole = 'owner';
  api.getCurrentUser.mockResolvedValue({
    id: 42,
    name: 'Acme',
    email: 'owner@acme.com',
    company_name: 'Acme Corporation',
    website: 'https://acme.com',
    kind: 'client',
  });
  api.updateClientProfile.mockImplementation(async (patch: Record<string, string>) => ({
    id: 42,
    name: patch.name ?? 'Acme',
    email: 'owner@acme.com',
    company_name: patch.company_name ?? 'Acme Corporation',
    website: patch.website ?? 'https://acme.com',
    pending_email: null,
  }));
});

describe('GeneralPage — the four states', () => {
  it('shows a loading placeholder rather than an empty form', () => {
    api.getCurrentUser.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(document.querySelector('[aria-busy]')).not.toBeNull();
  });

  it('says what failed, and offers a retry', async () => {
    api.getCurrentUser.mockRejectedValue(new Error('gateway timeout'));
    renderPage();
    expect(await screen.findByText('We could not load this workspace')).toBeInTheDocument();
    expect(screen.getByText('gateway timeout')).toBeInTheDocument();
  });

  it('does not show a team seat a save button that would always 403', async () => {
    workspace.currentRole = 'operator';
    renderPage();
    expect(
      await screen.findByText('Only the workspace owner can change this'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
  });
});

describe('GeneralPage — unsaved changes are visible and recoverable', () => {
  it('says everything is saved until something is not', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByDisplayValue('Acme');

    expect(screen.getByText('Everything here is saved.')).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^name$/i), ' Ltd');
    // Names the field, rather than announcing an anonymous change.
    expect(await screen.findByText(/Unsaved changes to Name\./)).toBeInTheDocument();
  });

  it('discards back to the server’s copy without a request', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByDisplayValue('Acme');

    await user.type(screen.getByLabelText(/^name$/i), ' Ltd');
    await user.click(screen.getByRole('button', { name: /discard/i }));

    expect(screen.getByLabelText(/^name$/i)).toHaveValue('Acme');
    expect(screen.getByText('Everything here is saved.')).toBeInTheDocument();
    expect(api.updateClientProfile).not.toHaveBeenCalled();
  });

  it('sends only the fields that actually moved', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByDisplayValue('Acme');

    await user.type(screen.getByLabelText(/^name$/i), ' Ltd');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(api.updateClientProfile).toHaveBeenCalledWith({ name: 'Acme Ltd' }));
    // And the rail is told, or it keeps rendering the old name until a reload.
    expect(workspace.refresh).toHaveBeenCalled();
  });

  it('cannot be saved while it is already saved', async () => {
    renderPage();
    await screen.findByDisplayValue('Acme');
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /discard/i })).toBeDisabled();
  });

  it('puts a validation failure on the field that caused it', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByDisplayValue('Acme');

    await user.clear(screen.getByLabelText(/^name$/i));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const name = screen.getByLabelText(/^name$/i);
    expect(await screen.findByText(/Give the workspace a name/i)).toBeInTheDocument();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(api.updateClientProfile).not.toHaveBeenCalled();
  });

  it('rejects a website that is not one, without touching the other fields', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByDisplayValue('Acme');

    const website = screen.getByLabelText(/website/i);
    await user.clear(website);
    await user.type(website, 'not a website');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/not a valid web address/i)).toBeInTheDocument();
    expect(api.updateClientProfile).not.toHaveBeenCalled();
  });

  it('normalises a bare host so a pasted domain still resolves', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByDisplayValue('Acme');

    const website = screen.getByLabelText(/website/i);
    await user.clear(website);
    await user.type(website, 'acme.io');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(api.updateClientProfile).toHaveBeenCalledWith({ website: 'https://acme.io' }),
    );
  });
});
