import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentActionsMenu } from './AgentActionsMenu';
import { deleteBot, updateBot } from '../../services/api';
import type { Bot } from '../../types/domain';

vi.mock('../../services/api', () => ({
  updateBot: vi.fn(),
  deleteBot: vi.fn(),
  trackDemoShareClick: vi.fn(),
  getBotDemoUrl: (key: string) => `https://demo.test/${key}`,
}));

vi.mock('../../ui/overlays/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const bot: Bot = { id: 17, name: 'Support Concierge', bot_key: 'bot-6a427d4529b9' };

function renderMenu() {
  const onChanged = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentActionsMenu bot={bot} onChanged={onChanged} />
    </QueryClientProvider>,
  );
  return onChanged;
}

async function openMenuItem(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole('button', { name: 'Actions for Support Concierge' }));
  await user.click(await screen.findByRole('menuitem', { name }));
}

describe('AgentActionsMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Rename had no validation at all: an empty or whitespace-only value closed
   * the editor silently, exactly as if it had saved.
   */
  it('refuses an empty name instead of pretending to save it', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenuItem(user, /rename/i);

    await user.clear(screen.getByLabelText(/chatbot name/i));
    await user.click(screen.getByRole('button', { name: 'Save name' }));

    expect(await screen.findByText('Give the chatbot a name.')).toBeInTheDocument();
    expect(vi.mocked(updateBot)).not.toHaveBeenCalled();
  });

  it('refuses a whitespace-only name', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenuItem(user, /rename/i);

    const input = screen.getByLabelText(/chatbot name/i);
    await user.clear(input);
    await user.type(input, '   ');
    await user.click(screen.getByRole('button', { name: 'Save name' }));

    expect(vi.mocked(updateBot)).not.toHaveBeenCalled();
  });

  it('saves a trimmed name and tells the list to refetch', async () => {
    const user = userEvent.setup();
    vi.mocked(updateBot).mockResolvedValue({ message: 'ok' });
    const onChanged = renderMenu();
    await openMenuItem(user, /rename/i);

    const input = screen.getByLabelText(/chatbot name/i);
    await user.clear(input);
    await user.type(input, '  Acme Support  ');
    await user.click(screen.getByRole('button', { name: 'Save name' }));

    await waitFor(() => expect(vi.mocked(updateBot)).toHaveBeenCalledWith(17, { name: 'Acme Support' }));
    expect(onChanged).toHaveBeenCalled();
  });

  /**
   * The menu it replaces shared one `error` string with the delete dialog, so a
   * refused rename surfaced its message under a button that deletes a knowledge
   * base.
   */
  it('keeps a failed rename out of the delete confirmation', async () => {
    const user = userEvent.setup();
    vi.mocked(updateBot).mockRejectedValue(new Error('That name is already taken.'));
    renderMenu();
    await openMenuItem(user, /rename/i);

    const input = screen.getByLabelText(/chatbot name/i);
    await user.clear(input);
    await user.type(input, 'Taken');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('That name is already taken.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await openMenuItem(user, /delete/i);

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(screen.queryByText('That name is already taken.')).not.toBeInTheDocument();
  });

  /**
   * A destructive action confirms, and the confirmation asks for the chatbot's
   * name — its knowledge base, conversations and leads cannot be recreated.
   */
  it('holds the delete until the name is typed exactly', async () => {
    const user = userEvent.setup();
    vi.mocked(deleteBot).mockResolvedValue({});
    const onChanged = renderMenu();
    await openMenuItem(user, /delete/i);

    const confirm = await screen.findByRole('button', { name: 'Delete chatbot' });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByRole('textbox'), 'Support Concierge');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(vi.mocked(deleteBot)).toHaveBeenCalledWith(17));
    expect(onChanged).toHaveBeenCalled();
  });

  /**
   * The old dialog left `busy` set after the request settled, so a failure left
   * it stuck on "Deleting…" with dismissal blocked and no way out but a reload.
   */
  it('stays open, explains itself and can be dismissed after a failed delete', async () => {
    const user = userEvent.setup();
    vi.mocked(deleteBot).mockRejectedValue(new Error('This chatbot has an active subscription.'));
    renderMenu();
    await openMenuItem(user, /delete/i);

    await user.type(await screen.findByRole('textbox'), 'Support Concierge');
    await user.click(screen.getByRole('button', { name: 'Delete chatbot' }));

    expect(
      await screen.findByText('This chatbot has an active subscription.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete chatbot' })).toBeEnabled();
  });
});
