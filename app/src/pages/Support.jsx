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
    // Track whether Messages has been visited at least once so we lazy-mount it
    // only on first visit — avoids unnecessary API calls while keeping it alive
    // (hidden) after that so OfflineMessages doesn't lose its fetch state either.
    const [messagesVisited, setMessagesVisited] = useState(initialTab === 'messages');

    const handleTabChange = (tab) => {
        if (tab === 'messages') setMessagesVisited(true);
        setActiveTab(tab);
    };

    return (
        <div className="space-y-4 animate-fade-in">
            <PageHeader title="Support" subtitle="Manage live conversations and offline messages" />
            <Tabs tabs={tabs} activeTab={activeTab} onChange={handleTabChange} />

            {/*
             * LiveChat is always mounted — never conditionally removed — so its
             * WebSocket connection and isOnline state survive tab switches.
             * Switching to Messages no longer resets the operator back to "offline".
             */}
            <div className={activeTab !== 'live-chat' ? 'hidden' : ''}>
                <LiveChat embedded />
            </div>

            {/* OfflineMessages is lazy-mounted on first visit, then kept hidden when inactive */}
            {messagesVisited && (
                <div className={activeTab !== 'messages' ? 'hidden' : ''}>
                    <OfflineMessages embedded />
                </div>
            )}
        </div>
    );
}
