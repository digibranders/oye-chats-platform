import { useState, type ReactElement } from 'react';
import { PageContainer, StatusBadge, Button } from '../../design-system';
import { Tabs, type TabItem } from '../../design-system/components/Tabs';
import { useBotContext } from '../../context/BotContext';
import { OfflineMessagesPanel } from './OfflineMessagesPanel';
import { LiveChatPanel } from './LiveChatPanel';
import { useOperatorStatus } from './useOperatorStatus';

type InboxTab = 'messages' | 'live';

const TABS: TabItem[] = [
  { key: 'messages', label: 'Messages' },
  { key: 'live', label: 'Live chat' },
];

/**
 * InboxPage — answers "What are my visitors saying?".
 *
 * One job: give an operator a single place to read and respond to visitors. Two
 * modes behind a tab: fully-wired offline messages (read, triage, reply, delete)
 * and a scaffolded live-chat console. Availability lives in the header so it’s
 * reachable from either tab; the inbox is scoped to the active agent.
 */
export function InboxPage(): ReactElement {
  const { selectedBot } = useBotContext();
  const botId = selectedBot?.id;
  const [tab, setTab] = useState<InboxTab>('messages');
  const operator = useOperatorStatus(botId);

  return (
    <PageContainer
      title="Inbox"
      description="See what your visitors are saying and respond fast."
      actions={
        operator.unavailable ? null : (
          <div className="flex items-center gap-2">
            <StatusBadge tone={operator.isOnline ? 'success' : 'neutral'} dot>
              {operator.isOnline ? 'Online' : 'Offline'}
            </StatusBadge>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void operator.toggle()}
              disabled={operator.saving || operator.loading}
            >
              {operator.saving ? 'Saving…' : operator.isOnline ? 'Go offline' : 'Go online'}
            </Button>
          </div>
        )
      }
    >
      <Tabs
        tabs={TABS}
        value={tab}
        onChange={(key) => setTab(key as InboxTab)}
        ariaLabel="Inbox sections"
      />

      <div
        role="tabpanel"
        id="tabpanel-messages"
        aria-labelledby="tab-messages"
        hidden={tab !== 'messages'}
      >
        {tab === 'messages' && <OfflineMessagesPanel botId={botId} />}
      </div>

      <div role="tabpanel" id="tabpanel-live" aria-labelledby="tab-live" hidden={tab !== 'live'}>
        {tab === 'live' && <LiveChatPanel operator={operator} />}
      </div>
    </PageContainer>
  );
}
