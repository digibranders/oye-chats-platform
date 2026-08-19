import { Navigate, Route, Routes } from 'react-router-dom';
import { TabPanel, Tabs } from '../../ui';
import { PlatformPage } from '../PlatformPage';
import { useUrlState } from '../usePlatform';
import { AudienceTab } from './AudienceTab';
import { BotDetailPage, ChatbotsTab } from './ChatbotsTab';
import { ConversationsTab, SessionDetailPage } from './ConversationsTab';
import { EngagementTab } from './EngagementTab';
import { FeedbackTab } from './FeedbackTab';
import { KnowledgeTab } from './KnowledgeTab';

const TABS = [
  { value: 'chatbots', label: 'Chatbots' },
  { value: 'knowledge', label: 'Knowledge' },
  { value: 'conversations', label: 'Conversations' },
  { value: 'engagement', label: 'Leads & follow-up' },
  { value: 'audience', label: 'Audience' },
  { value: 'feedback', label: 'Feedback' },
];

/** Filter keys owned by one tab. Cleared on a tab change so a stale filter cannot follow the reader. */
const SCOPED_FILTERS = {
  q: null,
  view: null,
  state: null,
  source: null,
  status: null,
  client_id: null,
  bot_id: null,
  session_id: null,
  dimension: null,
  type: null,
  area: null,
  severity: null,
  rating: null,
  sort: null,
};

function RecordsIndex() {
  const url = useUrlState();
  const tab = url.get('tab', 'chatbots');

  return (
    <PlatformPage
      title="Records"
      description="Every object a customer owns: chatbots, the knowledge behind them, and everything their visitors produced."
    >
      <Tabs
        label="Record types"
        items={TABS}
        value={tab}
        onValueChange={(next) => url.set({ ...SCOPED_FILTERS, tab: next })}
      >
        {/* Only the selected panel's body is mounted: rendering all six would
            fire a dozen requests on load for lists nobody is looking at. */}
        <TabPanel value="chatbots">{tab === 'chatbots' ? <ChatbotsTab /> : null}</TabPanel>
        <TabPanel value="knowledge">{tab === 'knowledge' ? <KnowledgeTab /> : null}</TabPanel>
        <TabPanel value="conversations">
          {tab === 'conversations' ? <ConversationsTab /> : null}
        </TabPanel>
        <TabPanel value="engagement">{tab === 'engagement' ? <EngagementTab /> : null}</TabPanel>
        <TabPanel value="audience">{tab === 'audience' ? <AudienceTab /> : null}</TabPanel>
        <TabPanel value="feedback">{tab === 'feedback' ? <FeedbackTab /> : null}</TabPanel>
      </Tabs>
    </PlatformPage>
  );
}

/**
 * The Data section.
 *
 * Fourteen endpoints, grouped into six by the question they answer rather than
 * by the router file they live in — a rail entry each would have made the
 * navigation longer than the work. Two of them earn their own route because
 * their answer is something one super-admin sends to another: a chatbot, and a
 * conversation.
 */
export function RecordsPage() {
  return (
    <Routes>
      <Route index element={<RecordsIndex />} />
      <Route path="bots/:botId" element={<BotDetailPage />} />
      <Route path="sessions/:sessionId" element={<SessionDetailPage />} />
      <Route path="*" element={<Navigate to="." replace />} />
    </Routes>
  );
}
