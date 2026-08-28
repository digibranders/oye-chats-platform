import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two things a key surface has to get right.
 *
 * A masked key has no copy button — the previous page had one, and it copied
 * the bullets. And rotating the key ends every session in the workspace,
 * because the console authenticates with the same `X-API-Key`; the previous
 * page rotated and left the stale key in storage, so the next request 401'd and
 * threw the user to the login screen holding a key they had not copied.
 */

const api = vi.hoisted(() => ({
  getClientApiKey: vi.fn(),
  regenerateClientApiKey: vi.fn(),
  getApiBaseUrl: vi.fn(() => 'https://api.oyechats.com'),
}));
vi.mock('../../services/api', () => api);

const authStorage = vi.hoisted(() => ({
  setAuthItem: vi.fn(),
  // Null by default: most cases here are 'this browser has no live copy'.
  getAuthItem: vi.fn((_key: string) => null as string | null),
}));
vi.mock('../../utils/authStorage', () => authStorage);

const entitlements = vi.hoisted(() => ({
  hasFeature: ((_key: string) => false) as (key: string) => boolean,
}));
vi.mock('../../hooks/useEntitlements', () => ({ useEntitlements: () => entitlements }));

const workspace = vi.hoisted(() => ({ currentRole: 'owner' as string | null }));
vi.mock('../../context/WorkspaceContext', () => ({ useWorkspace: () => workspace }));

const { ApiKeysPage } = await import('./ApiKeysPage');

// A menu, a dialog and a mutation sit comfortably inside the default 5s budget
// in isolation, and comfortably outside it when the whole suite runs in
// parallel on a loaded machine. This is a statement about the runner, not about
// what is being asserted — the assertions themselves all settle in milliseconds.
vi.setConfig({ testTimeout: 20_000 });

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings/developers']}>
        <Routes>
          <Route path="/settings/developers" element={<ApiKeysPage />} />
          <Route path="/billing" element={<p>Billing</p>} />
          <Route path="/account" element={<p>Account</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  workspace.currentRole = 'owner';
  entitlements.hasFeature = () => false;
  api.getClientApiKey.mockResolvedValue({ api_key_masked: '••••••a3f9' });
  api.regenerateClientApiKey.mockResolvedValue({
    ok: true,
    api_key: 'newkey1234567890',
    api_key_masked: '••••••7890',
  });
  api.getApiBaseUrl.mockReturnValue('https://api.oyechats.com');
});

describe('ApiKeysPage — the four states', () => {
  it('shows a loading placeholder in the key card', () => {
    api.getClientApiKey.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(document.querySelector('[aria-busy]')).not.toBeNull();
  });

  it('says the key could not be loaded, with a retry', async () => {
    api.getClientApiKey.mockRejectedValue(new Error('service unavailable'));
    renderPage();
    expect(await screen.findByText('We could not load your API key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('does not show a team seat the workspace credential', async () => {
    workspace.currentRole = 'operator';
    renderPage();
    expect(
      await screen.findByText('Only the workspace owner can see the API key'),
    ).toBeInTheDocument();
    expect(api.getClientApiKey).not.toHaveBeenCalled();
  });
});

describe('ApiKeysPage — the key itself', () => {
  it('never offers to copy the mask', async () => {
    // No local credential at all, so the mask is the only truth there is.
    renderPage();
    expect(await screen.findByText('••••••a3f9')).toBeInTheDocument();
    // The only copyable things on the page before a rotation are the base URL
    // and the example request — never the masked key.
    expect(screen.queryByRole('button', { name: /copy .*api key/i })).not.toBeInTheDocument();
  });

  it('offers the real key when this browser is holding the current one', async () => {
    // The console authenticates with the workspace key itself, so `admin_token`
    // IS the key. Without this the only way to recover a key you had not
    // written down was Rotate — revoking every live integration to read a
    // secret already sitting in this tab.
    authStorage.getAuthItem.mockReturnValue('livekey00000000a3f9');
    const user = userEvent.setup();
    renderPage();

    const reveal = await screen.findByRole('button', { name: /reveal workspace api key/i });
    expect(screen.getByRole('button', { name: /copy workspace api key/i })).toBeInTheDocument();
    // Masked until asked for, and then the whole key — not the bullets.
    expect(screen.queryByText('livekey00000000a3f9')).not.toBeInTheDocument();
    await user.click(reveal);
    expect(await screen.findByText('livekey00000000a3f9')).toBeInTheDocument();
  });

  it('withholds a local key that no longer matches the server', async () => {
    // Rotated on another device: storage still holds the old value, and the
    // server's mask ends in different characters. Handing that over would be
    // the same lie as copying the mask.
    authStorage.getAuthItem.mockReturnValue('stalekey0000dead');
    renderPage();

    expect(await screen.findByText('••••••a3f9')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /copy workspace api key/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/rotated on another device/i)).toBeInTheDocument();
  });

  it('states the whole consequence before rotating, including this session', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('••••••a3f9');

    await user.click(screen.getByRole('button', { name: /rotate key/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/start getting 401s/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/shown once/i)).toBeInTheDocument();
    expect(api.regenerateClientApiKey).not.toHaveBeenCalled();
  });

  it('writes the new key back into the session, so the console stays signed in', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('••••••a3f9');

    await user.click(screen.getByRole('button', { name: /rotate key/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /rotate key/i }));

    await waitFor(() => expect(api.regenerateClientApiKey).toHaveBeenCalled());
    expect(authStorage.setAuthItem).toHaveBeenCalledWith('admin_token', 'newkey1234567890');
  });

  it('shows the new key in full exactly once, and says so', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('••••••a3f9');

    await user.click(screen.getByRole('button', { name: /rotate key/i }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: /rotate key/i }));

    const reveal = await screen.findByRole('dialog');
    expect(within(reveal).getByText('newkey1234567890')).toBeInTheDocument();
    expect(within(reveal).getByRole('button', { name: /copy new api key/i })).toBeInTheDocument();
    expect(within(reveal).getByText(/becomes a mask/i)).toBeInTheDocument();
  });
});

describe('ApiKeysPage — plan flags', () => {
  it('surfaces api_access and online_support instead of resolving them invisibly', async () => {
    renderPage();
    await screen.findByText('••••••a3f9');
    expect(screen.getByText('API access')).toBeInTheDocument();
    expect(screen.getByText('Priority support')).toBeInTheDocument();
    expect(screen.getAllByText('Not included').length).toBeGreaterThanOrEqual(2);
  });

  it('reports them as included when the plan actually grants them', async () => {
    entitlements.hasFeature = () => true;
    renderPage();
    await screen.findByText('••••••a3f9');
    expect(screen.getAllByText('Included').length).toBeGreaterThanOrEqual(3);
  });
});
