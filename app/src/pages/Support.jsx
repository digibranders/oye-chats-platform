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

    return (
        <div className="space-y-4 animate-fade-in">
            <PageHeader title="Support" subtitle="Manage live conversations and offline messages" />
            <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

            {activeTab === 'live-chat' && <LiveChat embedded />}
            {activeTab === 'messages' && <OfflineMessages embedded />}
        </div>
    );
}
