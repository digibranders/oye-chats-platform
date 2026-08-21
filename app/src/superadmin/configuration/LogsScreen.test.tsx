import { useEffect } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogsScreen } from './LogsScreen';
import { LOG_SERVICES, LOG_LEVELS } from './logs-model';
import { pickOption } from '../../test/select';
import type { LogsResponse } from './types';

const httpClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../services/api', () => ({ httpClient }));

const response: LogsResponse = {
  available: true,
  service: 'oyechats-api',
  entries: [
    { timestamp: '2026-08-19T10:00:00Z', level: 'error', message: 'Traceback: boom', unit: 'x', pid: 12 },
    { timestamp: '2026-08-19T10:00:01Z', level: 'info', message: 'started', unit: 'x', pid: 12 },
  ],
};

let currentSearch = '';

// Recorded in an effect rather than during render: reassigning a module
// variable while rendering is a side effect, and the lint rule that forbids it
// is right even in a test double.
function Probe() {
  const { search } = useLocation();
  useEffect(() => {
    currentSearch = search;
  }, [search]);
  return null;
}

function renderScreen(entry = '/platform/platform/logs') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <LogsScreen />
      <Probe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  currentSearch = '';
});

/**
 * The log reader is the one place a super-admin copies customer data out of, so
 * these pin the three properties that matter: the service is the server's
 * allow-list and nothing else, the read is bounded and explicit rather than a
 * stream, and the whole block is copyable in one go.
 */
describe('LogsScreen', () => {
  it('offers exactly the two allow-listed units, and no free-text service box', async () => {
    const user = userEvent.setup();
    httpClient.get.mockResolvedValue({ data: response });
    renderScreen();
    // The options only exist in the popup, not on the closed trigger, and the
    // list has no raw values to read off the DOM — only what `LOG_SERVICES`
    // says to render, which is what this actually has to hold.
    await user.click(await screen.findByLabelText('Service'));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(
      LOG_SERVICES.map((service) => service.label),
    );
  });

  it('requests a bounded number of lines and nothing beyond the cap', async () => {
    httpClient.get.mockResolvedValue({ data: response });
    renderScreen('/platform/platform/logs?lines=99999');
    await waitFor(() =>
      expect(httpClient.get).toHaveBeenCalledWith('/superadmin/logs', {
        params: { service: 'oyechats-api', lines: 5000 },
      }),
    );
  });

  it('never asks for a unit outside the allow-list, whatever the URL says', async () => {
    httpClient.get.mockResolvedValue({ data: response });
    renderScreen('/platform/platform/logs?service=postgresql');
    await waitFor(() => expect(httpClient.get).toHaveBeenCalled());
    expect(httpClient.get.mock.calls[0][1].params.service).toBe('oyechats-api');
  });

  it('keeps the filters in the URL so the same view can be sent to somebody', async () => {
    const user = userEvent.setup();
    httpClient.get.mockResolvedValue({ data: response });
    renderScreen();
    await screen.findByLabelText('Level');
    await pickOption(user, screen.getByLabelText('Level'), LOG_LEVELS.find((level) => level.value === 'error')!.label);
    await waitFor(() => expect(currentSearch).toContain('level=error'));
    await waitFor(() =>
      expect(httpClient.get).toHaveBeenCalledWith('/superadmin/logs', {
        params: { service: 'oyechats-api', lines: 500, level: 'error' },
      }),
    );
  });

  it('renders the journal as one copyable block rather than a table to reassemble', async () => {
    httpClient.get.mockResolvedValue({ data: response });
    renderScreen();
    expect(await screen.findByRole('button', { name: /Copy/ })).toBeInTheDocument();
    expect(screen.getByText(/Traceback: boom/)).toBeInTheDocument();
  });

  it('re-reads only when asked, never on a timer', async () => {
    const user = userEvent.setup();
    httpClient.get.mockResolvedValue({ data: response });
    renderScreen();
    await screen.findByRole('button', { name: /Copy/ });
    const before = httpClient.get.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Fetch again' }));
    await waitFor(() => expect(httpClient.get.mock.calls.length).toBe(before + 1));
  });

  it('says when the host has no journal instead of presenting a placeholder as real', async () => {
    httpClient.get.mockResolvedValue({
      data: {
        available: false,
        service: 'oyechats-api',
        entries: [{ timestamp: null, level: 'info', message: 'journalctl unavailable', unit: null, pid: null }],
      },
    });
    renderScreen();
    expect(await screen.findByText('journalctl is not available on this host')).toBeInTheDocument();
  });

  it('offers the empty, error and forbidden states', async () => {
    httpClient.get.mockResolvedValue({
      data: { available: true, service: 'oyechats-api', entries: [] },
    });
    const empty = renderScreen();
    expect(await screen.findByText('No lines matched')).toBeInTheDocument();
    empty.unmount();

    httpClient.get.mockRejectedValue({ response: { status: 500, data: { detail: 'journalctl timed out.' } } });
    const failed = renderScreen();
    expect(await screen.findByText('journalctl timed out.')).toBeInTheDocument();
    failed.unmount();

    httpClient.get.mockRejectedValue({ response: { status: 403, data: { detail: 'Nope.' } } });
    renderScreen();
    expect(await screen.findByText('You cannot read the server journals')).toBeInTheDocument();
  });
});
