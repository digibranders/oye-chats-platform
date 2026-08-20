import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlagsScreen } from './FlagsScreen';

const httpClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../services/api', () => ({ httpClient }));

const ROWS = [
  { key: 'kill_switch', value: false, updated_at: '2026-08-01T10:00:00Z' },
  { key: 'feature.email_verification_enabled', value: true, updated_at: null },
  { key: 'feature.company_name_enabled', value: true, updated_at: null },
  { key: 'credit_cost.ai_chat', value: 1, updated_at: null },
  { key: 'rag.chunk_size', value: 1000, updated_at: null },
];

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/platform/platform']}>
      <FlagsScreen />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * A flag is a switch on production, so the whole screen is one contract: the
 * current value is readable without opening anything, and no flip reaches the
 * API without a confirmation that names the consequence.
 */
describe('FlagsScreen', () => {
  it('shows the current value of every switch without opening anything', async () => {
    httpClient.get.mockResolvedValue({ data: ROWS });
    renderScreen();
    const killSwitch = await screen.findByRole('switch', { name: 'Credit kill switch' });
    expect(killSwitch).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Email verification' })).toBeChecked();
  });

  it('does not show the credit prices or the RAG knobs as flags', async () => {
    httpClient.get.mockResolvedValue({ data: ROWS });
    renderScreen();
    await screen.findByRole('switch', { name: 'Credit kill switch' });
    expect(screen.queryByRole('switch', { name: /credit_cost/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /rag\./ })).not.toBeInTheDocument();
    // …and says where they went instead of hiding them.
    expect(screen.getByRole('link', { name: 'Credit pricing' })).toHaveAttribute(
      'href',
      '/platform/catalogue/pricing',
    );
  });

  it('never writes a flag on the first click', async () => {
    const user = userEvent.setup();
    httpClient.get.mockResolvedValue({ data: ROWS });
    renderScreen();

    await user.click(await screen.findByRole('switch', { name: 'Credit kill switch' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(httpClient.put).not.toHaveBeenCalled();
  });

  it('states the consequence of the direction being taken, then writes it', async () => {
    const user = userEvent.setup();
    httpClient.get.mockResolvedValue({ data: ROWS });
    httpClient.put.mockResolvedValue({ data: { key: 'kill_switch', value: true } });
    renderScreen();

    await user.click(await screen.findByRole('switch', { name: 'Credit kill switch' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/every credit deduction raises/i);
    expect(dialog).toHaveTextContent('kill_switch: false → true');

    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() =>
      expect(httpClient.put).toHaveBeenCalledWith('/superadmin/feature-flags/kill_switch', {
        value: true,
      }),
    );
  });

  it('leaves the switch alone when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    httpClient.get.mockResolvedValue({ data: ROWS });
    renderScreen();

    await user.click(await screen.findByRole('switch', { name: 'Credit kill switch' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(httpClient.put).not.toHaveBeenCalled();
    expect(screen.getByRole('switch', { name: 'Credit kill switch' })).not.toBeChecked();
  });

  it('reports a refused write instead of leaving the switch looking flipped', async () => {
    const user = userEvent.setup();
    httpClient.get.mockResolvedValue({ data: ROWS });
    httpClient.put.mockRejectedValue({
      response: { status: 403, data: { detail: 'Read-only super-admin: writes are not permitted.' } },
    });
    renderScreen();

    await user.click(await screen.findByRole('switch', { name: 'Credit kill switch' }));
    await user.click(await screen.findByRole('button', { name: 'Turn on' }));

    expect(
      await screen.findByText('Read-only super-admin: writes are not permitted.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Credit kill switch' })).not.toBeChecked();
  });

  it('says which documented switches have no row rather than implying they are off', async () => {
    httpClient.get.mockResolvedValue({ data: [ROWS[0]] });
    renderScreen();
    expect(await screen.findByText('Some switches have no row yet')).toBeInTheDocument();
  });

  it('offers the four states: loading, empty, error and forbidden', async () => {
    httpClient.get.mockReturnValue(new Promise(() => {}));
    const loading = renderScreen();
    expect(loading.container.querySelector('[aria-busy]')).toBeTruthy();
    loading.unmount();

    httpClient.get.mockResolvedValue({ data: [] });
    const empty = renderScreen();
    expect(await screen.findByText('No switch is stored')).toBeInTheDocument();
    empty.unmount();

    httpClient.get.mockRejectedValue({ response: { status: 500, data: { detail: 'Redis down.' } } });
    const failed = renderScreen();
    expect(await screen.findByText('Redis down.')).toBeInTheDocument();
    failed.unmount();

    httpClient.get.mockRejectedValue({ response: { status: 403, data: { detail: 'Nope.' } } });
    renderScreen();
    expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
  });
});
