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
  mergeViews,
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
    // "Replied" claimed something nothing observed. The status is written when
    // the mailto link is clicked, and the badge travels to every operator.
    expect(toOfflineItem({ id: 3, status: 'replied' }).state?.label).toBe('Reply opened');
  });

  it('asserts no presence for a queue row, because the payload carries none', () => {
    // `QueueItem` has no presence field, and this hard-coded `true`, so a
    // two-day-old queue entry pulsed "Online now" beside "Waiting 2d".
    const waiting = toWaitingItem({
      session_id: '7',
      name: 'Ada',
      reason: null,
      bot_id: null,
      bot_name: null,
      created_at: new Date(NOW - 2 * 86_400_000).toISOString(),
    });
    expect(waiting.online).toBe(false);
  });
});

describe('mergeViews', () => {
  /**
   * The All scope, and the reason it is a merge rather than a concatenation.
   *
   * The four buckets are not disjoint. A visitor the AI has scored is in
   * `qualified`, and the moment they ask for a person they are in `waiting`
   * too — same session, same row id, two rows. Concatenated, All showed the
   * name twice; and because selection is keyed by row id, clicking either copy
   * selected both and the list drew two highlighted rows.
   */
  it('shows a conversation reported by two sources once', () => {
    const merged = mergeViews({
      waiting: [item({ id: 's.7', name: 'Ada', kind: 'waiting' })],
      yours: [],
      messages: [],
      qualified: [item({ id: 's.7', name: 'Ada', kind: 'qualified' })],
    });
    expect(merged).toHaveLength(1);
  });

  it('keeps the copy of the row that carries the action', () => {
    // Which copy survives is not arbitrary. The waiting row is the one with an
    // Accept button behind it; the qualified row is read-only. Keeping the
    // wrong one would render a queue the operator cannot answer from.
    const merged = mergeViews({
      waiting: [item({ id: 's.7', name: 'Ada', kind: 'waiting' })],
      yours: [],
      messages: [],
      qualified: [item({ id: 's.7', name: 'Ada', kind: 'qualified' })],
    });
    expect(merged[0].kind).toBe('waiting');
  });

  it('carries every distinct row from every bucket', () => {
    const merged = mergeViews({
      waiting: [item({ id: 's.1', name: 'Ada' })],
      yours: [item({ id: 's.2', name: 'Bea' })],
      messages: [item({ id: 'm.3', name: 'Cy', kind: 'offline' })],
      qualified: [item({ id: 's.4', name: 'Dee' })],
    });
    expect(merged.map((row) => row.id)).toEqual(['s.1', 's.2', 'm.3', 's.4']);
  });
});

function List({
  onSelect,
  error = null,
  initialView = 'yours',
  online = false,
  counts,
}: {
  onSelect: (row: InboxItem) => void;
  error?: string | null;
  initialView?: InboxView;
  online?: boolean;
  counts?: Record<InboxView, number | null>;
}) {
  const [view, setView] = useState<InboxView>(initialView);
  const [selected, setSelected] = useState('s.a');
  const rows = [
    item({ id: 's.a', name: 'Ada', at: '2026-08-19T11:59:00Z', online }),
    item({ id: 's.b', name: 'Bea', at: '2026-08-19T11:58:00Z' }),
    item({ id: 's.c', name: 'Cy', at: '2026-08-19T11:57:00Z' }),
  ];
  return (
    <ConversationList
      view={view}
      onViewChange={setView}
      counts={counts ?? { all: rows.length, waiting: 0, yours: rows.length, messages: 0, qualified: 0 }}
      items={rows}
      selectedId={selected}
      onSelect={(row) => {
        setSelected(row.id);
        onSelect(row);
      }}
      query=""
      onQueryChange={() => {}}
      loading={false}
      error={error}
      now={NOW}
    />
  );
}

describe('ConversationList', () => {
  it('drops the scope count when that scope failed to load', () => {
    // "Messages (0)" sat in the switcher beside the list's own "Could not load
    // your messages", so the pane reported a measurement it had not taken and
    // contradicted itself in the same 300px.
    render(
      <List
        onSelect={vi.fn()}
        initialView="messages"
        error="Could not load your messages"
      />,
    );
    const scope = screen.getByRole('combobox', { name: /conversation scope/i });
    expect(scope).toHaveTextContent('Messages');
    expect(scope).not.toHaveTextContent('Messages (0)');
  });

  /**
   * The online dot's ring, which rendered as an oval.
   *
   * The dot sits in a `bg-surface` ring so it reads against the avatar behind
   * it. That ring was a plain `<span>` — display `inline` — and padding on an
   * inline box is drawn from the FONT's content area, not from the 8px child:
   * measured in a real browser it came out 12x21, a tall white blob hanging
   * off the avatar's corner. A flex box pads symmetrically, so 12x12.
   *
   * jsdom computes no layout, so what is pinned here is the box type that
   * decides it.
   */
  it('rings the online dot with a box that can actually be a circle', () => {
    render(<List onSelect={vi.fn()} online />);
    // The label sits inside `StatusDot`'s own root, and the ring is the box
    // wrapping that: label -> StatusDot -> ring.
    const label = screen.getAllByText('Online now')[0];
    const ring = label.parentElement?.parentElement;
    expect(ring).not.toBeNull();
    expect(ring!.className).toContain('rounded-full');
    expect(ring!.className).toMatch(/(^|\s)flex(\s|$)/);
  });

  it('offers All, which is the scope the inbox opens on', () => {
    render(<List onSelect={vi.fn()} initialView="all" />);
    expect(screen.getByRole('combobox', { name: /conversation scope/i })).toHaveTextContent(
      'All (3)',
    );
  });

  it('drops a count it does not have, rather than reporting it as zero', () => {
    // Reachable from any scope now, not just the one that failed: All is in
    // front of the operator by default, and a Messages fetch that failed
    // underneath it used to sit in the switcher as a confident "Messages (0)".
    render(
      <List
        onSelect={vi.fn()}
        initialView="all"
        counts={{ all: null, waiting: 0, yours: 3, messages: null, qualified: 0 }}
      />,
    );
    const scope = screen.getByRole('combobox', { name: /conversation scope/i });
    expect(scope).toHaveTextContent('All');
    expect(scope).not.toHaveTextContent('All (');
  });

  it('keeps the count for a scope that loaded', () => {
    render(<List onSelect={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: /conversation scope/i })).toHaveTextContent(
      'Yours (3)',
    );
  });

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

  /**
   * Three speakers, and only two of them are boxes.
   *
   * They used to be three fills: ink for the operator, white for the visitor,
   * and `--color-surface-sunken` for the AI — 1.8 L* off the canvas this sits
   * on, under the 2.4 L* step `tokens.css` sets as the floor for a felt
   * difference. The AI's bubble barely read as a bubble, and beside the
   * visitor's white it barely read as different, so an AI-handled conversation
   * was a wall of near-identical boxes.
   *
   * The fix is not a third fill. A machine and a person are different KINDS of
   * turn, which is what the widget and the lead drawer already say by giving
   * the AI an avatar and plain text. Pinned because "give the AI its own
   * colour" is the obvious wrong answer and someone will reach for it again.
   */
  it('gives the AI plain text where the people get bubbles', () => {
    const { container } = render(
      <Transcript
        visitorName="Ada"
        messages={[
          message({ key: '1', role: 'user', content: 'from the visitor' }),
          message({ key: '2', role: 'bot', content: 'from the AI' }),
          message({ key: '3', role: 'operator', content: 'from me' }),
        ]}
      />,
    );
    // Read off the message column rather than walking up from the text: the
    // AI's words sit inside `Markdown`'s own wrapper, so `closest('div')`
    // finds that instead of the box under test. Each column's first child IS
    // the box, in message order.
    const boxes = [...container.querySelectorAll('div')]
      .filter((el) => el.className.includes('max-w-[min(34rem'))
      .map((column) => (column.firstElementChild as HTMLElement).className);
    expect(boxes).toHaveLength(3);
    const [visitor, ai, me] = boxes;

    // The two people are filled boxes with a radius.
    expect(visitor).toMatch(/rounded-md/);
    expect(visitor).toMatch(/bg-surface/);
    expect(me).toMatch(/bg-ink/);

    // The AI is not: no fill, no border, no radius, no padding.
    expect(ai).not.toMatch(/rounded-md/);
    expect(ai).not.toMatch(/bg-/);
    expect(ai).not.toMatch(/border/);
    expect(ai).not.toMatch(/px-3/);
  });

  it('holds every message to a reading measure', () => {
    // 34rem is about 73 characters of `text-prose`; comfortable prose is 45 to
    // 75. It was `min(42rem,80%)` — about 95 characters — and 80% of a pane
    // that can be 900px wide is wider still. The AI writes the longest
    // messages here, so it was the AI's answers the measure failed worst.
    render(<Transcript visitorName="Ada" messages={[message({ key: '1', content: 'measured' })]} />);
    const column = screen.getByText('measured').closest('div')?.parentElement;
    expect(column?.className).toContain('max-w-[min(34rem,82%)]');
  });

  it('announces the visitor typing rather than showing three silent dots', () => {
    render(<Transcript visitorName="Ada" messages={[]} visitorTyping />);
    expect(screen.getByRole('status', { name: /ada is typing/i })).toBeInTheDocument();
  });

  /**
   * The AI writes markdown; a person writes what they typed.
   *
   * The transcript printed every message verbatim, so the operator read
   * `**Clean Images**` where the visitor had been shown bold. Fixing it for
   * everyone would have been worse than the bug: a visitor's asterisks are
   * their own text, and an operator's reply is typed into a plain box with no
   * markdown affordance anywhere near it.
   */
  it('renders the AI\'s markdown as formatting', () => {
    render(
      <Transcript
        visitorName="Ada"
        messages={[message({ key: '1', role: 'bot', content: '- **Clean Images**' })]}
      />,
    );
    expect(screen.getByText('Clean Images').tagName).toBe('STRONG');
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  it('leaves what a person typed exactly as they typed it', () => {
    render(
      <Transcript
        visitorName="Ada"
        messages={[
          message({ key: '1', role: 'user', content: 'is it **really** free?' }),
          message({ key: '2', role: 'operator', content: 'the *plan* covers it' }),
        ]}
      />,
    );
    expect(screen.getByText('is it **really** free?')).toBeInTheDocument();
    expect(screen.getByText('the *plan* covers it')).toBeInTheDocument();
  });
});
