import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { OfflineMessage } from '../../types/domain';
import { MessagePane } from './MessagePane';

/**
 * There is no send-mail endpoint behind this pane. Clicking the mailto link
 * writes `status: 'replied'` server-side, and the badge that produces travels
 * to every other operator, so it may only claim what was actually observed:
 * somebody opened the link.
 */
function message(overrides: Partial<OfflineMessage> = {}): OfflineMessage {
  return {
    id: 7,
    bot_name: 'Support bot',
    visitor_name: 'Ada Lovelace',
    visitor_email: 'ada@example.com',
    message_body: 'Do you support SSO?',
    status: 'new',
    created_at: '2026-08-19T10:00:00Z',
    ...overrides,
  };
}

function renderPane(overrides: Partial<OfflineMessage> = {}, onStatusChange = vi.fn()) {
  render(
    <MessagePane
      message={message(overrides)}
      snippets={[]}
      onManageSnippets={vi.fn()}
      onStatusChange={onStatusChange}
      onDelete={vi.fn()}
    />,
  );
  return onStatusChange;
}

describe('MessagePane', () => {
  it('names the replied state for what was actually observed', () => {
    renderPane({ status: 'replied' });
    expect(screen.getByText('Reply opened')).toBeInTheDocument();
    expect(screen.queryByText('Replied')).not.toBeInTheDocument();
    // And says what put it there, beside the badge.
    expect(screen.getByText('Marked when the mail link was opened')).toBeInTheDocument();
  });

  it('does not carry that caveat before anything has been opened', () => {
    renderPane({ status: 'new' });
    expect(screen.queryByText('Marked when the mail link was opened')).not.toBeInTheDocument();
  });

  it('still writes the status the API accepts when the mail link is used', async () => {
    const onStatusChange = renderPane({ status: 'read' });
    await userEvent.click(screen.getByRole('link', { name: /open in your email app/i }));
    expect(onStatusChange).toHaveBeenCalledWith(7, 'replied');
  });
});
