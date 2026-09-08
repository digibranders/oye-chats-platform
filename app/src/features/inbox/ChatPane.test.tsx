import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../services/api';
import { ChatPane } from './ChatPane';
import { InboxSocketContext } from './inboxSocket';
import type { OperatorSocketApi } from './useOperatorSocket';
import type { InboxItem } from './inboxModel';

/**
 * The one toggle a narrow screen has for the visitor-details pane:
 * `SplitPane`'s inspector column only renders `@6xl/page` (1152 of split
 * width) and up, so below that this button is the ONLY way to reach it —
 * `InboxPage` opens a `Drawer` from it. Untested before this file, which is
 * exactly the kind of gap a width-threshold regression hides in: the button
 * is one `onShowDetails ? <Button> : null` away from silently never
 * rendering, and nothing short of a real narrow viewport would show it.
 */

vi.mock('../../services/api', () => ({
  acceptChat: vi.fn(),
  cancelConnectRequest: vi.fn(),
  closeOperatorChat: vi.fn(),
  resolveOperatorChat: vi.fn(),
  sendConnectRequest: vi.fn(),
  uploadOperatorChatFile: vi.fn(),
  translateForSession: vi.fn(),
}));

vi.mock('./inboxQueries', () => ({
  useTranscript: () => ({ messages: [], loading: false, error: null, reload: vi.fn() }),
}));

const SOCKET: OperatorSocketApi = {
  status: 'connected',
  operatorId: 1,
  operatorName: 'Ana',
  queue: [],
  activeChats: {},
  messagesBySession: {},
  endedBySession: {},
  serverOnline: true,
  typingBySession: {},
  presenceBySession: {},
  unreadBySession: {},
  visitorReadAtBySession: {},
  hasMoreBySession: {},
  roster: [],
  qualifiedVersion: 0,
  connectResolutions: {},
  lastError: null,
  operatorLanguage: null,
  operatorAvailableLocales: [],
  setOperatorLanguage: vi.fn(),
  sendMessage: vi.fn(() => true),
  sendFile: vi.fn(() => true),
  sendTyping: vi.fn(),
  sendReadReceipt: vi.fn(),
  loadHistory: vi.fn(async () => {}),
  loadOlder: vi.fn(async () => {}),
  clearUnread: vi.fn(),
  applyTranslation: vi.fn(),
  clearConnectResolution: vi.fn(),
  reclaim: vi.fn(),
};

const ITEM: InboxItem = {
  id: 's.session-1',
  kind: 'waiting',
  sessionId: 'session-1',
  messageId: null,
  name: 'Priya',
  preview: 'Hello there',
  at: '2026-08-19T11:59:00Z',
  botName: 'Support bot',
  unread: 0,
  state: null,
  online: false,
};

function renderPane(onShowDetails?: () => void, overrides: Partial<InboxItem> = {}, draft = '') {
  const onDraftChange = vi.fn();
  const view = render(
    <InboxSocketContext.Provider value={SOCKET}>
      <ChatPane
        item={{ ...ITEM, ...overrides }}
        draft={draft}
        onDraftChange={onDraftChange}
        snippets={[]}
        onManageSnippets={vi.fn()}
        now={Date.parse('2026-08-19T12:00:00Z')}
        onLeft={vi.fn()}
        onShowDetails={onShowDetails}
      />
    </InboxSocketContext.Provider>,
  );
  return { ...view, onDraftChange };
}

/**
 * Taking a waiting visitor, and where the control for it lives.
 *
 * It used to be a primary button in the header's actions cluster, at the far
 * top-right of the pane, sharing a row with the visitor's name and a wait
 * badge — while the bottom of the pane, where an operator's eye and hand
 * actually end up after reading a transcript, held a grey line reading "Accept
 * the conversation to reply." That is a dead end: it names the precondition
 * instead of offering the action that satisfies it, about 900px diagonally
 * from the control that does. The person who built this console could not find
 * it.
 *
 * Nobody thinks "I will accept this conversation". They think "I will answer
 * this person", so answering is what accepts.
 */
describe('ChatPane — taking a waiting visitor', () => {
  beforeEach(() => {
    vi.mocked(api.acceptChat).mockReset();
    vi.mocked(api.acceptChat).mockResolvedValue(undefined as never);
    vi.mocked(SOCKET.sendMessage).mockClear();
    vi.mocked(SOCKET.sendMessage).mockReturnValue(true);
  });

  it('offers a real composer, not a notice about one', () => {
    renderPane();
    expect(screen.getByRole('textbox', { name: /reply to this visitor/i })).toBeEnabled();
    expect(screen.queryByText(/Accept the conversation to reply/i)).toBeNull();
  });

  it('says what the send button is about to do, given what is in the box', () => {
    // Accepting takes a seat against the operator's concurrent-chat limit and
    // tells a visitor somebody is here. That is not a thing to learn from a
    // paper-plane glyph — and the label has to follow the draft, because
    // pressing it with an empty box does something different.
    const empty = renderPane();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled();
    empty.unmount();

    renderPane(undefined, {}, 'hello');
    expect(screen.getByRole('button', { name: 'Accept and reply' })).toBeEnabled();
  });

  it('leaves the primary live on arrival, when nothing has been typed', () => {
    // The whole reported defect was not finding the control. A greyed-out
    // button is not a thing anybody hunts for, so the empty state accepts
    // rather than disabling: claim the visitor now, write in a moment.
    renderPane();
    expect(screen.getByRole('button', { name: 'Accept' })).not.toBeDisabled();
  });

  it('accepts and sends in one action', async () => {
    const user = userEvent.setup();
    const { onDraftChange } = renderPane(undefined, {}, 'hello, how can I help?');

    await user.click(screen.getByRole('button', { name: 'Accept and reply' }));

    await waitFor(() => expect(api.acceptChat).toHaveBeenCalledWith('session-1', 1));
    expect(SOCKET.sendMessage).toHaveBeenCalledWith('session-1', 'hello, how can I help?');
    expect(onDraftChange).toHaveBeenCalledWith('');
  });

  it('keeps the draft when a colleague got there first', async () => {
    // Losing the conversation is bad enough. Throwing away what they had
    // written on top of it is the wrong way to be told.
    vi.mocked(api.acceptChat).mockRejectedValue(new Error('Asha is already on this conversation'));
    const user = userEvent.setup();
    const { onDraftChange } = renderPane(undefined, {}, 'hello, how can I help?');

    await user.click(screen.getByRole('button', { name: 'Accept and reply' }));

    expect(await screen.findByText(/Asha is already on this conversation/)).toBeInTheDocument();
    expect(SOCKET.sendMessage).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalledWith('');
  });

  it('claims the visitor without sending an empty message', async () => {
    // Take it before a colleague does, compose afterwards. There is nothing to
    // send, and sending an empty line to the visitor would be worse than
    // sending nothing.
    const user = userEvent.setup();
    renderPane();
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(api.acceptChat).toHaveBeenCalledWith('session-1', 1));
    expect(SOCKET.sendMessage).not.toHaveBeenCalled();
  });

  it('offers one accept control, not two', () => {
    // `DESIGN.md`: at most one primary per view. The header used to carry a
    // copy of this button, and an earlier pass at this fix put a second,
    // quieter one beside the hint — which puts the operator in front of a
    // choice they did not ask for.
    renderPane();
    expect(screen.getAllByRole('button', { name: /^Accept/ })).toHaveLength(1);
  });

  it('does not tell the visitor somebody is typing before anyone has accepted', async () => {
    // A typing indicator from an operator who has not taken the conversation
    // is a promise the console has not made.
    const user = userEvent.setup();
    renderPane();
    await user.type(screen.getByRole('textbox', { name: /reply to this visitor/i }), 'hi');
    expect(SOCKET.sendTyping).not.toHaveBeenCalled();
  });
});

describe('ChatPane — the visitor-details toggle', () => {
  it('offers a way back to visitor details when the pane is not on screen beside it', async () => {
    const user = userEvent.setup();
    const onShowDetails = vi.fn();
    renderPane(onShowDetails);

    const button = screen.getByRole('button', { name: 'Show visitor details' });
    await user.click(button);
    expect(onShowDetails).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate the toggle when the inspector already sits beside this pane', () => {
    renderPane(undefined);
    expect(screen.queryByRole('button', { name: 'Show visitor details' })).not.toBeInTheDocument();
  });
});

/**
 * The read receipt, which nothing asserted before this.
 *
 * The chain that turns the visitor's grey double-tick green is long — the
 * console reads the message's db id off the socket frame, takes the highest
 * one a visitor sent, sends `read_receipt`, the server checks the operator
 * really holds that conversation and relays it, and the widget upgrades every
 * message at or below that id. `sendReadReceipt` was mocked in this file and
 * never asserted, so any break in the console's half of it would have shipped
 * silently: the operator sees nothing missing, and only the visitor's own
 * screen is wrong.
 */
describe('ChatPane — telling the visitor their message was read', () => {
  const liveItem: InboxItem = { ...ITEM, kind: 'live' };

  function renderLive(socket: Partial<OperatorSocketApi>) {
    return render(
      <InboxSocketContext.Provider value={{ ...SOCKET, ...socket } as OperatorSocketApi}>
        <ChatPane
          item={liveItem}
          draft=""
          onDraftChange={vi.fn()}
          snippets={[]}
          onManageSnippets={vi.fn()}
          now={Date.parse('2026-08-19T12:00:00Z')}
          onLeft={vi.fn()}
        />
      </InboxSocketContext.Provider>,
    );
  }

  it('reports the highest visitor message id on screen', () => {
    const sendReadReceipt = vi.fn();
    renderLive({
      sendReadReceipt,
      messagesBySession: {
        'session-1': [
          { key: 'srv-273', dbId: 273, role: 'user', content: 'hello', timestamp: null },
          // The operator's own reply is not something to mark as read, and its
          // id must not be what gets reported.
          { key: 'srv-276', dbId: 276, role: 'operator', content: 'Okay', timestamp: null },
          { key: 'srv-275', dbId: 275, role: 'user', content: 'i need 100 images', timestamp: null },
        ],
      },
    });

    expect(sendReadReceipt).toHaveBeenCalledWith('session-1', 275);
  });

  it('says nothing when the socket is not connected', () => {
    // The frame would be dropped on the floor, and recording it as sent would
    // mean the reconnect never re-sends it.
    const sendReadReceipt = vi.fn();
    renderLive({
      status: 'reconnecting',
      sendReadReceipt,
      messagesBySession: {
        'session-1': [{ key: 'srv-273', dbId: 273, role: 'user', content: 'hello', timestamp: null }],
      },
    });

    expect(sendReadReceipt).not.toHaveBeenCalled();
  });

  it('says nothing for a conversation that is not live', () => {
    // A waiting or offline item has no visitor socket listening for it.
    const sendReadReceipt = vi.fn();
    render(
      <InboxSocketContext.Provider
        value={
          {
            ...SOCKET,
            sendReadReceipt,
            messagesBySession: {
              'session-1': [{ key: 'srv-273', dbId: 273, role: 'user', content: 'hi', timestamp: null }],
            },
          } as OperatorSocketApi
        }
      >
        <ChatPane
          item={ITEM}
          draft=""
          onDraftChange={vi.fn()}
          snippets={[]}
          onManageSnippets={vi.fn()}
          now={Date.parse('2026-08-19T12:00:00Z')}
          onLeft={vi.fn()}
        />
      </InboxSocketContext.Provider>,
    );

    expect(sendReadReceipt).not.toHaveBeenCalled();
  });
});
