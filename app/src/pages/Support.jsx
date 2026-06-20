import { useState } from 'react';
import { Headphones, Inbox } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import Tabs from '../components/ui/Tabs';
import PageHeader from '../components/ui/PageHeader';
import LiveChatStatusPill from '../components/LiveChatStatusPill';
import LiveChat from './LiveChat';
import OfflineMessages from './OfflineMessages';

const tabs = [
  { id: 'live-chat', label: 'Live Chat', icon: Headphones },
  { id: 'messages', label: 'Messages', icon: Inbox },
];

export default function Support() {
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') || 'live-chat';
  const [activeTab, setActiveTab] = useState(initialTab);
  const [messagesVisited, setMessagesVisited] = useState(initialTab === 'messages');

  const handleTabChange = (tab) => {
    if (tab === 'messages') setMessagesVisited(true);
    setActiveTab(tab);
  };

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex-shrink-0">
        <PageHeader title="Support" subtitle="Manage live conversations and offline messages" />
        {/* Live chat readiness — shows the empty-state nudge for workspaces
            with zero operators, or the operator-online count once configured.
            Placed between the header and tabs so it's visible on first load
            but doesn't crowd the active tab content. */}
        <div className="mt-3">
          <LiveChatStatusPill />
        </div>
        <div className="mt-4">
          <Tabs tabs={tabs} activeTab={activeTab} onChange={handleTabChange} />
        </div>
      </div>

      <div className={`flex-1 min-h-0 ${activeTab !== 'live-chat' ? 'hidden' : ''}`}>
        <LiveChat embedded />
      </div>

      {messagesVisited && (
        <div className={activeTab !== 'messages' ? 'hidden' : ''}>
          <OfflineMessages embedded />
        </div>
      )}
    </div>
  );
}
