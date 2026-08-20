import { Navigate, Route, Routes } from 'react-router-dom';
import { NavTabs } from '../../ui';
import { PlatformPage } from '../PlatformPage';
import { PLATFORM_ROOT } from '../nav';
import { GrowthEventsTab, VisitorsTab } from './AudienceTab';
import { BotDetailPage, ChatbotsTab } from './ChatbotsTab';
import { ConversationsTab, LiveQueueTab, SessionDetailPage } from './ConversationsTab';
import {
  LeadsTab,
  MeetingsTab,
  OfflineMessagesTab,
  QualificationTab,
} from './EngagementTab';
import { ChatRatingsTab, ProductFeedbackTab } from './FeedbackTab';
import { CrawlsTab, DocumentsTab } from './KnowledgeTab';

const BASE = `${PLATFORM_ROOT}/records`;

/**
 * Every record list, in one flat row.
 *
 * It used to be six tabs, four of which then drew a `SegmentedControl` for their
 * own two-to-four sub-views: page title → tab row → segmented control → toolbar
 * → table was four bands and about 230px of chrome above the first row of data,
 * on a surface whose entire job is scanning rows. There are thirteen
 * destinations here and thirteen is a tab row — `NavTabs` scrolls rather than
 * wraps — so each is one click and one address instead of two of each.
 */
const TABS = [
  { to: BASE, label: 'Chatbots', end: true },
  { to: `${BASE}/knowledge`, label: 'Documents' },
  { to: `${BASE}/crawls`, label: 'Crawls' },
  { to: `${BASE}/conversations`, label: 'Conversations' },
  { to: `${BASE}/queue`, label: 'Live queue' },
  { to: `${BASE}/leads`, label: 'Leads' },
  { to: `${BASE}/offline`, label: 'Offline' },
  { to: `${BASE}/meetings`, label: 'Meetings' },
  { to: `${BASE}/qualification`, label: 'Qualification' },
  { to: `${BASE}/visitors`, label: 'Visitors' },
  { to: `${BASE}/growth`, label: 'Growth' },
  { to: `${BASE}/feedback`, label: 'Feedback' },
  { to: `${BASE}/ratings`, label: 'Ratings' },
];

/**
 * The records index.
 *
 * A route per list rather than a tab in the query string, which also retires the
 * hand-maintained list of "filter keys owned by one tab" that had to be cleared
 * on every switch: a link to another view carries no query string, so no filter
 * can follow the reader into a list it does not belong to.
 */
function RecordsIndex() {
  return (
    <PlatformPage title="Records" toolbarBleed toolbar={<NavTabs label="Record types" items={TABS} />}>
      <Routes>
        <Route index element={<ChatbotsTab />} />
        <Route path="knowledge" element={<DocumentsTab />} />
        <Route path="crawls" element={<CrawlsTab />} />
        <Route path="conversations" element={<ConversationsTab />} />
        <Route path="queue" element={<LiveQueueTab />} />
        <Route path="leads" element={<LeadsTab />} />
        <Route path="offline" element={<OfflineMessagesTab />} />
        <Route path="meetings" element={<MeetingsTab />} />
        <Route path="qualification" element={<QualificationTab />} />
        <Route path="visitors" element={<VisitorsTab />} />
        <Route path="growth" element={<GrowthEventsTab />} />
        <Route path="feedback" element={<ProductFeedbackTab />} />
        <Route path="ratings" element={<ChatRatingsTab />} />
        <Route path="*" element={<Navigate to={BASE} replace />} />
      </Routes>
    </PlatformPage>
  );
}

/**
 * The Data section.
 *
 * Fourteen endpoints, grouped by the question they answer rather than by the
 * router file they live in — a rail entry each would have made the navigation
 * longer than the work. Two of them earn their own route because their answer is
 * something one super-admin sends to another: a chatbot, and a conversation.
 */
export function RecordsPage() {
  return (
    <Routes>
      <Route path="bots/:botId" element={<BotDetailPage />} />
      <Route path="sessions/:sessionId" element={<SessionDetailPage />} />
      {/* The splat, so the index's own `Routes` resolves against what is left of
          the path rather than against an already-consumed segment. */}
      <Route path="*" element={<RecordsIndex />} />
    </Routes>
  );
}
