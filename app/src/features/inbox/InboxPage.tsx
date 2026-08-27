import { useState, type ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Inbox as InboxIcon } from 'lucide-react';
import { PageContainer } from '../../design-system';
import { Tabs, type TabItem } from '../../design-system/components/Tabs';
import { FeatureGate } from '../../design-system/components/FeatureGate';
import { LockedFeatureCard } from '../../design-system/components/LockedFeatureCard';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useBotContext } from '../../context/BotContext';
import { OfflineMessagesPanel } from './OfflineMessagesPanel';
import { LiveChatPanel } from './LiveChatPanel';
import { CannedResponsesPanel } from './CannedResponsesPanel';
import { useOperatorStatus } from './useOperatorStatus';
import { useTranslation } from '../../i18n/useTranslation';

type InboxTab = 'messages' | 'live' | 'replies';

// @i18n-exempt: resolved at the render site from the tab key
// (`inbox.tab.<key>`); the labels here are that lookup's English fallback.
const TABS: TabItem[] = [
  // Module constant: evaluated at import, before a locale exists. The label is
  // resolved at render from the tab key (`TabItem` is a design-system type and
  // gaining a `labelKey` for one consumer would be the wrong place to put it).
  { key: 'messages', label: 'Messages' },
  { key: 'live', label: 'Live chat' },
  { key: 'replies', label: 'Quick replies' },
];

/**
 * InboxPage - answers "What are my visitors saying?".
 *
 * One job: give an operator a single place to read and respond to visitors. Two
 * modes behind a tab: fully-wired offline messages (read, triage, reply, delete)
 * and a scaffolded live-chat console. Live-chat availability is owned by the Live
 * chat tab (where it’s relevant), not the shared header; the inbox is scoped to
 * the active agent.
 */
const TAB_KEYS: readonly InboxTab[] = ['messages', 'live', 'replies'];

export function InboxPage(): ReactElement {
  const { t } = useTranslation();
  const { selectedBot } = useBotContext();
  const botId = selectedBot?.id;
  const { isFree } = useEntitlements();
  const [searchParams] = useSearchParams();
  // Honour a deep link (e.g. the incoming-chat banner routes to
  // `/inbox?tab=live`) as the initial tab; falls back to Messages.
  const requestedTab = searchParams.get('tab') as InboxTab | null;
  const [tab, setTab] = useState<InboxTab>(
    requestedTab && TAB_KEYS.includes(requestedTab) ? requestedTab : 'messages',
  );
  const operator = useOperatorStatus(botId);

  // Support / live chat is a paid workspace. The sidebar renders the nav item
  // locked on Free, but a Free user who deep-links `/inbox` lands here - so
  // guard the whole surface with the same upgrade teaser instead of showing an
  // empty (Free never has live chat or offline messages) support console.
  // Placed after every hook so hook order stays stable across the plan resolving.
  if (isFree) {
    return (
      <PageContainer
        title={t('inbox.support') || 'Support'}
        description={t('inbox.seeWhatYourVisitorsAre') || 'See what your visitors are saying and respond fast.'}
      >
        <div className="mx-auto w-full max-w-md py-12">
          <LockedFeatureCard intent="view_support" icon={InboxIcon} />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer
      title={t('inbox.support') || 'Support'}
      description={t('inbox.seeWhatYourVisitorsAre') || 'See what your visitors are saying and respond fast.'}
    >
      <Tabs
        tabs={TABS.map((tab) => ({
          ...tab,
          label: t(`inbox.tab.${tab.key}`) || tab.label,
        }))}
        value={tab}
        onChange={(key) => setTab(key as InboxTab)}
        ariaLabel={t('inbox.supportSections') || 'Support sections'}
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
        {tab === 'live' && (
          <FeatureGate feature="live_chat" intent="live_chat">
            <LiveChatPanel operator={operator} botId={botId} />
          </FeatureGate>
        )}
      </div>

      <div role="tabpanel" id="tabpanel-replies" aria-labelledby="tab-replies" hidden={tab !== 'replies'}>
        {tab === 'replies' && (
          <FeatureGate feature="live_chat" intent="add_canned_response">
            <CannedResponsesPanel />
          </FeatureGate>
        )}
      </div>
    </PageContainer>
  );
}
