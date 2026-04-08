import { useState } from 'react';
import { Headphones, Inbox } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import Tabs from '../components/ui/Tabs';
import PageHeader from '../components/ui/PageHeader';
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
    <div className="space-y-4">
      <PageHeader title="Support" subtitle="Manage live conversations and offline messages" />
      <Tabs tabs={tabs} activeTab={activeTab} onChange={handleTabChange} />

      <div className={activeTab !== 'live-chat' ? 'hidden' : ''}>
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
