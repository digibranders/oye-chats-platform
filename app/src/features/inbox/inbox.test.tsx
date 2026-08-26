import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { ConversationList } from './ConversationList';
import { formatDayLabel } from '../../lib/messageDay';
import { Transcript } from './Transcript';
import {
  byRecency,
  matchesQuery,
  sessionIdFromItemId,
  shortAgo,
  toOfflineItem,
  toWaitingItem,
  waitLabel,
  waitTone,
  type InboxItem,
  type InboxView,
} from './inboxModel';
import type { OperatorMessage } from './liveChatProtocol';

/**
 * What is covered here is what breaks silently: the keyboard path through the
 * conversation list, the composer's send/newline split, the snippet menu, and
 * the transcript's day grouping. Each maps to a defect the console this replaces
 * actually shipped — rows that were `div`s with a click handler and no keyboard
 * path at all, Enter inserting a newline instead of sending, and a day divider
 * accumulated in a variable mutated during render.
 */

const NOW = Date.parse('2026-08-19T12:00:00Z');

function item(overrides: Partial<InboxItem> & Pick<InboxItem, 'id' | 'name'>): InboxItem {
  return {
    kind: 'live',
    sessionId: overrides.id.replace(/^s\./, ''),
    messageId: null,
    preview: 'Hello there',
    at: '2026-08-19T11:59:00Z',
    botName: 'Support bot',
    unread: 0,
    state: null,
    online: false,
    ...overrides,
  };
}

describe('inboxModel', () => {
  it('reads a wait as a running duration, not a time in the past', () => {
    expect(waitLabel(new Date(NOW - 30_000).toISOString(), NOW)).toBe('30s');
    expect(waitLabel(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m');
    expect(waitLabel(new Date(NOW - 90 * 60_000).toISOString(), NOW)).toBe('1h 30m');
  });

  it('abbreviates a row timestamp so the name beside it keeps its width', () => {
    // A queue where every row reads "14 hours ago" spends ~90px of a 320px row
    // on a phrase nobody reads word by word, and truncates the name that
    // matters. The long form is still on the row's title and announced.
    expect(shortAgo(new Date(NOW - 20_000).toISOString(), NOW)).toBe('now');
    expect(shortAgo(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m');
    expect(shortAgo(new Date(NOW - 14 * 3_600_000).toISOString(), NOW)).toBe('14h');
    expect(shortAgo(new Date(NOW - 3 * 86_400_000).toISOString(), NOW)).toBe('3d');
    expect(shortAgo(new Date(NOW - 20 * 86_400_000).toISOString(), NOW)).toBe('2w');
    expect(shortAgo(null, NOW)).toBe('');
  });

  it('escalates a wait past ten minutes rather than only counting it', () => {
    expect(waitTone(new Date(NOW - 60_000).toISOString(), NOW)).toBe('warning');
    expect(waitTone(new Date(NOW - 11 * 60_000).toISOString(), NOW)).toBe('danger');
  });

  it('sorts newest first and puts undated rows last, not first', () => {
    const rows = [
      item({ id: 's.a', name: 'A', at: null }),
      item({ id: 's.b', name: 'B', at: '2026-08-19T10:00:00Z' }),
      item({ id: 's.c', name: 'C', at: '2026-08-19T11:00:00Z' }),
    ].sort(byRecency);
    expect(rows.map((row) => row.name)).toEqual(['C', 'B', 'A']);
  });

  it('matches a query against the name, the preview and the chatbot', () => {
    const row = item({ id: 's.a', name: 'Ada Lovelace', preview: 'about pricing' });
    expect(matchesQuery(row, 'ada')).toBe(true);
    expect(matchesQuery(row, 'PRICING')).toBe(true);
    expect(matchesQuery(row, 'support bot')).toBe(true);
    expect(matchesQuery(row, 'nothing')).toBe(false);
  });

  it('namespaces row ids so a message id cannot be read as a session id', () => {
    const message = toOfflineItem({ id: 7, message_body: 'Hi', status: 'new' });
    const waiting = toWaitingItem({
      session_id: '7',
      name: null,
      reason: null,
      bot_id: null,
      bot_name: null,
    });
    expect(message.id).not.toBe(waiting.id);
    expect(sessionIdFromItemId(message.id)).toBeNull();
    expect(sessionIdFromItemId(waiting.id)).toBe('7');
  });

  it('counts an unread offline message so both scopes mean the same thing', () => {
    expect(toOfflineItem({ id: 1, status: 'new' }).unread).toBe(1);
    expect(toOfflineItem({ id: 2, status: 'read' }).unread).toBe(0);
    expect(toOfflineItem({ id: 3, status: 'replied' }).state?.label).toBe('Replied');
  });
});

function List({ onSelect }: { onSelect: (row: InboxItem) => void }) {
  const [view, setView] = useState<InboxView>('yours');
  const [selected, setSelected] = useState('s.a');
  const rows = [
    item({ id: 's.a', name: 'Ada', at: '2026-08-19T11:59:00Z' }),
    item({ id: 's.b', name: 'Bea', at: '2026-08-19T11:58:00Z' }),
    item({ id: 's.c', name: 'Cy', at: '2026-08-19T11:57:00Z' }),
  ];
  return (
    <ConversationList
      view={view}
      onViewChange={setView}
      counts={{ waiting: 0, yours: rows.length, messages: 0, qualified: 0 }}
      items={rows}
      selectedId={selected}
      onSelect={(row) => {
        setSelected(row.id);
        onSelect(row);
      }}
      query=""
      onQueryChange={() => {}}
      loading={false}
      error={null}
      now={NOW}
    />
  );
}

describe('ConversationList', () => {
  it('is a listbox whose rows can be reached and chosen from the keyboard', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<List onSelect={onSelect} />);

    const list = screen.getByRole('listbox', { name: /yours conversations/i });
    const rows = within(list).getAllByRole('option');
    expect(rows).toHaveLength(3);
    // Roving tabindex: exactly one row is in the tab order at a time.
    expect(rows.filter((row) => row.getAttribute('tabindex') === '0')).toHaveLength(1);

    rows[0].focus();
    await user.keyboard('{ArrowDown}');
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Bea' }));

    await user.keyboard('{ArrowDown}');
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Cy' }));

    // End of the list is a floor, not a wrap: arrowing past the last row in a
    // queue must not silently jump the operator back to the top.
    await user.keyboard('{ArrowDown}');
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Cy' }));

    await user.keyboard('{Home}');
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Ada' }));
  });

  it('marks only the selected row as selected', () => {
    render(<List onSelect={() => {}} />);
    const selected = screen.getAllByRole('option').filter((row) => row.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
  });
});

function Box({
  onSend,
  snippets = [],
}: {
  onSend: (text: string) => void;
  snippets?: Array<{ id: number; title: string; content: string; shortcut?: string }>;
}) {
  const [value, setValue] = useState('');
  return (
    <Composer
      value={value}
      onChange={setValue}
      onSend={(text) => {
        onSend(text);
        setValue('');
      }}
      onAttach={async () => {}}
      onTyping={() => {}}
      snippets={snippets}
    />
  );
}

describe('Composer', () => {
  it('sends on Enter and breaks the line on Shift+Enter', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Box onSend={onSend} />);

    const box = screen.getByRole('textbox', { name: /reply to this visitor/i });
    await user.type(box, 'first line');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(box, 'second line');
    expect(onSend).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('first line\nsecond line');
  });

  it('will not send an empty or whitespace-only reply', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Box onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: /reply to this visitor/i });
    await user.type(box, '   ');
    await user.keyboard('{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /send reply/i })).toBeDisabled();
  });

  it('opens the saved-reply list on / and inserts the one chosen with the keyboard', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(
      <Box
        onSend={onSend}
        snippets={[
          { id: 1, title: 'Pricing', content: 'Our plans start at…', shortcut: 'pricing' },
          { id: 2, title: 'Refunds', content: 'We refund within 30 days.', shortcut: 'refund' },
        ]}
      />,
    );

    const box = screen.getByRole('textbox', { name: /reply to this visitor/i });
    await user.type(box, '/');
    const listbox = screen.getByRole('listbox', { name: /saved replies/i });
    expect(within(listbox).getAllByRole('option')).toHaveLength(2);

    await user.keyboard('{ArrowDown}{Enter}');
    expect(box).toHaveValue('We refund within 30 days.');
    // Enter chose from the menu; it must not also have sent the message.
    expect(onSend).not.toHaveBeenCalled();
  });

  it('explains why it is blocked instead of just going dead', () => {
    render(
      <Composer
        value=""
        onChange={() => {}}
        onSend={() => {}}
        onAttach={async () => {}}
        onTyping={() => {}}
        snippets={[]}
        disabledReason="Reconnecting — your reply will not send until the connection is back."
      />,
    );
    expect(screen.getByRole('textbox', { name: /reply to this visitor/i })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/reconnecting/i);
  });
});

function message(overrides: Partial<OperatorMessage> & Pick<OperatorMessage, 'key'>): OperatorMessage {
  return {
    dbId: null,
    role: 'user',
    content: 'Hello',
    timestamp: '2026-08-19T11:00:00Z',
    ...overrides,
  };
}

describe('Transcript', () => {
  it('draws one day divider per calendar day, in the right place', () => {
    render(
      <Transcript
        visitorName="Ada"
        messages={[
          message({ key: '1', timestamp: '2026-08-18T09:00:00Z' }),
          message({ key: '2', timestamp: '2026-08-18T10:00:00Z' }),
          message({ key: '3', timestamp: '2026-08-19T09:00:00Z' }),
        ]}
      />,
    );
    // Two days, two dividers — the version that accumulated the boundary in a
    // variable mutated during render produced one, on a re-render.
    //
    // `separator`, not `presentation`: the marker carries the day as its
    // accessible name now, so a screen-reader user reading a multi-day
    // transcript gets the boundaries a sighted reader does.
    const dividers = screen.getAllByRole('separator');
    expect(dividers).toHaveLength(2);
    // The newer day is the second one, and today's is named as such rather
    // than as a date the reader has to work out.
    expect(dividers[1]).toHaveAccessibleName(formatDayLabel('2026-08-19T09:00:00Z'));
  });

  it('names each voice, so the thread survives colour being stripped', () => {
    render(
      <Transcript
        visitorName="Ada"
        messages={[
          message({ key: '1', role: 'user' }),
          message({ key: '2', role: 'bot' }),
          message({ key: '3', role: 'operator' }),
        ]}
      />,
    );
    // One label per group of consecutive messages from one speaker, carried in
    // the screen-reader layer at the head of the group's first bubble — the
    // visible line under every single message was the same fact repeated.
    expect(screen.getByText('Visitor:')).toBeInTheDocument();
    expect(screen.getByText('AI:')).toBeInTheDocument();
    expect(screen.getByText('You:')).toBeInTheDocument();
  });

  it('announces the visitor typing rather than showing three silent dots', () => {
    render(<Transcript visitorName="Ada" messages={[]} visitorTyping />);
    expect(screen.getByRole('status', { name: /ada is typing/i })).toBeInTheDocument();
  });
});
