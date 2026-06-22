import { useEffect, useMemo, useState } from 'react';
import { Headphones, Inbox } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import Tabs from '../components/ui/Tabs';
import PageHeader from '../components/ui/PageHeader';
import LiveChatStatusPill from '../components/LiveChatStatusPill';
import LiveChat from './LiveChat';
import OfflineMessages from './OfflineMessages';
import useEntitlements from '../hooks/useEntitlements';
import { useUpgradeModal } from '../context/UpgradeModalContext';

export default function Support() {
  const [searchParams] = useSearchParams();
  const { entitlements: ent } = useEntitlements();
  const { requestUpgrade } = useUpgradeModal();
  // Live operator handoff lives behind the live_chat plan feature. Free
  // users still get the Messages inbox (visitors leaving offline messages
  // is a baseline trust feature) but the Live Chat tab is gated.
  const liveChatLocked = !ent.hasFeature('live_chat');

  // Tab definitions are memoised so a re-render from any source doesn't
  // recompute the array identity unnecessarily — the Tabs component uses
  // referential equality for some of its internal optimisations.
  const tabs = useMemo(
    () => [
      { id: 'live-chat', label: 'Live Chat', icon: Headphones, locked: liveChatLocked },
      { id: 'messages', label: 'Messages', icon: Inbox },
    ],
    [liveChatLocked],
  );

  // Default to Messages on Free since Live Chat is the gated surface.
  // Paid users default to Live Chat to match the original UX. The locked
  // case also clamps `?tab=live-chat` deep links so we never start on a
  // gated tab — the upgrade modal is fired once from the effect below.
  const requestedTab = searchParams.get('tab');
  const deepLinkedToLockedTab = requestedTab === 'live-chat' && liveChatLocked;
  const initialTab = deepLinkedToLockedTab
    ? 'messages'
    : (requestedTab || (liveChatLocked ? 'messages' : 'live-chat'));
  const [activeTab, setActiveTab] = useState(initialTab);
  const [messagesVisited, setMessagesVisited] = useState(initialTab === 'messages');

  // Fire the upgrade modal exactly once if the user deep-linked to the
  // locked Live Chat tab. We don't call any local setState here — the
  // initial-state computation above already routed the user to Messages —
  // so this effect is purely a side-effect trigger.
  useEffect(() => {
    if (deepLinkedToLockedTab) {
      requestUpgrade('view_support');
    }
    // Only run on mount: the effect's contract is "react to the URL's
    // arrival once", not "re-fire every time these inputs change".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTabChange = (tabOrId) => {
    // `Tabs` may pass either the tab id or the full tab object depending on
    // its version; handle both to stay forward-compatible.
    const id = typeof tabOrId === 'string' ? tabOrId : tabOrId?.id;
    const target = tabs.find((t) => t.id === id);
    if (target?.locked) {
      requestUpgrade('view_support');
      return;
    }
    if (id === 'messages') setMessagesVisited(true);
    setActiveTab(id);
  };

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex-shrink-0">
        <PageHeader title="Support" subtitle="Manage live conversations and offline messages" />
        {/* Live chat readiness — shows the empty-state nudge for workspaces
            with zero operators, or the operator-online count once configured.
            Hidden on Free because the surface it talks about is locked; the
            Messages-only experience doesn't benefit from this nudge. */}
        {!liveChatLocked && (
          <div className="mt-3">
            <LiveChatStatusPill />
          </div>
        )}
        <div className="mt-4">
          <Tabs tabs={tabs} activeTab={activeTab} onChange={handleTabChange} />
        </div>
      </div>

      {!liveChatLocked && (
        <div className={`flex-1 min-h-0 ${activeTab !== 'live-chat' ? 'hidden' : ''}`}>
          <LiveChat embedded />
        </div>
      )}

      {messagesVisited && (
        <div className={activeTab !== 'messages' ? 'hidden' : ''}>
          <OfflineMessages embedded />
        </div>
      )}
    </div>
  );
}
