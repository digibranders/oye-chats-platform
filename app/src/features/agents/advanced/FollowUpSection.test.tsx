import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowUpSection } from './FollowUpSection';
import { getBot, updateBot } from '../../../services/api';
import type { Bot } from '../../../types/domain';

vi.mock('../../../services/api', () => ({
  getBot: vi.fn(),
  updateBot: vi.fn(),
}));

vi.mock('../../../ui/overlays/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const agent: Bot = { id: 7, name: 'Support Concierge' };

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FollowUpSection agentId={7} />
    </QueryClientProvider>,
  );
}

/**
 * `Bot.followup_sending_paused` is the only control in the console that stops an
 * outbound email to a visitor. `PATCH /bots/{id}` accepts it now; the page it
 * sits on used to state in writing that no endpoint could set it.
 *
 * What is tested here is the three ways a kill switch lies: by taking effect
 * later than the person pressing it believes, by pausing without saying what
 * pausing costs, and by showing itself as flipped when the server refused.
 */
describe('FollowUpSection', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    vi.clearAllMocks();
    user = userEvent.setup();
    vi.mocked(getBot).mockResolvedValue({ ...agent, followup_sending_paused: false });
    vi.mocked(updateBot).mockResolvedValue({ message: 'ok' });
  });

  it('renders the server’s value, not a local guess', async () => {
    vi.mocked(getBot).mockResolvedValue({ ...agent, followup_sending_paused: true });
    renderSection();

    const toggle = await screen.findByRole('switch', { name: 'Pause follow-up emails' });
    expect(toggle).toBeChecked();
    expect(screen.getByText(/Anyone who tries to send one is told/i)).toBeInTheDocument();
  });

  it('states the consequence and writes nothing until it is confirmed', async () => {
    renderSection();
    await user.click(await screen.findByRole('switch', { name: 'Pause follow-up emails' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/Nobody on your team will be able to send a follow-up/i);
    expect(dialog).toHaveTextContent(/no queue, no retry, nothing sent later/i);
    expect(vi.mocked(updateBot)).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Pause follow-ups' }));
    await waitFor(() =>
      expect(vi.mocked(updateBot)).toHaveBeenCalledWith(7, { followup_sending_paused: true }),
    );
  });

  it('leaves the switch alone when the server refuses the pause', async () => {
    vi.mocked(updateBot).mockRejectedValue(new Error('Your session has expired.'));
    renderSection();

    const toggle = await screen.findByRole('switch', { name: 'Pause follow-up emails' });
    await user.click(toggle);
    await user.click(await screen.findByRole('button', { name: 'Pause follow-ups' }));

    // Once, in the dialog that asked for it — not also behind the scrim.
    const dialog = await screen.findByRole('alertdialog');
    expect(await screen.findByText('Your session has expired.')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Your session has expired.');
    // The switch never moved: the server still holds `false`, and follow-ups
    // are still being sent.
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('switch', { name: 'Pause follow-up emails' })).not.toBeChecked();
  });

  it('un-pauses without a confirmation, because letting sends resume is not the risk', async () => {
    vi.mocked(getBot).mockResolvedValue({ ...agent, followup_sending_paused: true });
    renderSection();

    await user.click(await screen.findByRole('switch', { name: 'Pause follow-up emails' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(updateBot)).toHaveBeenCalledWith(7, { followup_sending_paused: false }),
    );
  });

  it('reports a failed un-pause instead of leaving the switch looking off', async () => {
    vi.mocked(getBot).mockResolvedValue({ ...agent, followup_sending_paused: true });
    vi.mocked(updateBot).mockRejectedValue(new Error('Gateway timeout'));
    renderSection();

    await user.click(await screen.findByRole('switch', { name: 'Pause follow-up emails' }));

    expect(await screen.findByText('Gateway timeout')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Pause follow-up emails' })).toBeChecked();
  });

  it('answers a 403 with whose chatbot it is, not with a retry loop', async () => {
    vi.mocked(getBot).mockRejectedValue(
      Object.assign(new Error('Bot not found'), { status: 403 }),
    );
    renderSection();

    expect(await screen.findByText('This chatbot is not yours to change')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('explains a failed read and offers a way back', async () => {
    vi.mocked(getBot).mockRejectedValue(new Error('We could not reach the server.'));
    renderSection();

    expect(await screen.findByText('We could not reach the server.')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();

    vi.mocked(getBot).mockResolvedValue({ ...agent, followup_sending_paused: false });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('switch', { name: 'Pause follow-up emails' }),
    ).toBeInTheDocument();
  });
});
