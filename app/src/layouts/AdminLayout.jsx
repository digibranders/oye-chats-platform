import { useState, useEffect, useCallback } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageCircle } from 'lucide-react';
import { submitPlatformFeedback } from '../services/api';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import CommandPalette from '../components/CommandPalette';
import OnboardingWizard from '../components/OnboardingWizard';
import TrialBanner from '../components/TrialBanner';
import PushPermissionBanner from '../components/PushPermissionBanner';
import FeedbackModal from '../components/FeedbackModal';
import { PushProvider, usePush } from '../context/PushContext';
import { BotProvider, useBotContext } from '../context/BotContext';
import { NotificationProvider } from '../context/NotificationContext';
import LiveChatRequestBanner from '../components/LiveChatRequestBanner';

const MD_BREAKPOINT = 768;
const LG_BREAKPOINT = 1024;

const pageVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.15 } },
};

function AdminLayoutInner() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    const saved = localStorage.getItem('sidebar_open');
    if (saved !== null) return saved === 'true';
    return window.innerWidth >= LG_BREAKPOINT;
  });
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MD_BREAKPOINT);
  const [searchOpen, setSearchOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackTab, setFeedbackTab] = useState('send');
  const [feedbackHighlightId, setFeedbackHighlightId] = useState(null);

  // Push notifications — the subscription lifecycle now lives in PushContext
  // (mounted by the PushProvider wrapping this layout) so the
  // PushPermissionBanner here and the Settings → Notifications tab share one
  // source of truth. See PushContext.jsx / usePushNotifications.js.
  const push = usePush();

  const handleFeedbackSubmit = async (payload) => {
    await submitPlatformFeedback(payload);
  };
  const { bots, loading: botsLoading, error: botsError, refreshBots } = useBotContext();
  const location = useLocation();
  const navigate = useNavigate();

  // When the operator clicks a push notification while the dashboard is
  // already open in another tab, the service worker focuses the existing
  // tab and posts a navigation hint. The hint carries a fully-resolved
  // ``target_path`` so the same listener handles all three notification
  // variants without duplicating routing logic here:
  //   - handoff_request          → /support?session=<id>     (open the chat)
  //   - handoff_moved_to_offline → /support?tab=messages&... (open the message)
  //   - handoff_expired          → /support                  (lands on the tab)
  // ``target_path`` is validated same-origin in the SW; the legacy
  // ``session_id`` fallback is kept for rolling deploys where the new SW
  // hasn't activated yet on the operator's browser.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const handler = (event) => {
      if (event.data?.type !== 'oyechats:push-navigate') return;
      const target = event.data.target_path
        || (event.data.session_id
            ? `/support?session=${encodeURIComponent(event.data.session_id)}`
            : '/support');
      navigate(target);
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, [navigate]);

  // Deep-link from the "feedback resolved" notification: ``/?feedback=<id>``
  // opens the modal on the "My Feedback" tab and highlights the row, then
  // strips the param so a refresh/back doesn't re-open it.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has('feedback')) return;
    const raw = params.get('feedback');
    const id = Number(raw);
    /* eslint-disable react-hooks/set-state-in-effect -- opening the modal in response to a URL deep-link is an external-event sync */
    setFeedbackTab('mine');
    setFeedbackHighlightId(Number.isInteger(id) && id > 0 ? id : null);
    setFeedbackOpen(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    params.delete('feedback');
    const qs = params.toString();
    navigate(`${location.pathname}${qs ? `?${qs}` : ''}`, { replace: true });
  }, [location.search, location.pathname, navigate]);

  useEffect(() => {
    const handleResize = () => {
      const w = window.innerWidth;
      const nowMobile = w < MD_BREAKPOINT;
      setIsMobile(nowMobile);
      if (nowMobile) setIsSidebarOpen(false);
      else if (w >= LG_BREAKPOINT) setIsSidebarOpen(true);
      else setIsSidebarOpen(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    localStorage.setItem('sidebar_open', String(isSidebarOpen));
  }, [isSidebarOpen]);

  useEffect(() => {
    const isOperator = localStorage.getItem('auth_type') === 'operator';
    if (!isOperator && !botsLoading && !botsError && bots.length === 0 && !localStorage.getItem('onboarding_complete')) {
      setShowOnboarding(true); // eslint-disable-line react-hooks/set-state-in-effect -- one-time init from external state (localStorage)
    }
  }, [botsLoading, botsError, bots.length]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setSearchOpen(true); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const toggleSidebar = useCallback(() => setIsSidebarOpen(prev => !prev), []);
  const closeSidebar = useCallback(() => setIsSidebarOpen(false), []);
  const openSearch = useCallback(() => setSearchOpen(true), []);

  const getMarginClass = () => {
    if (isMobile) return 'ml-0';
    if (isSidebarOpen) return 'ml-60';
    return 'ml-[68px]';
  };

  return (
    <div className="h-screen overflow-hidden bg-surface-50 dark:bg-surface-950 flex transition-colors duration-300">
      {/* Mobile backdrop */}
      <AnimatePresence>
        {isMobile && isSidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-20"
            onClick={closeSidebar}
          />
        )}
      </AnimatePresence>

      <Sidebar isOpen={isSidebarOpen} isMobile={isMobile} onClose={closeSidebar} />

      <div className={`flex-1 flex flex-col transition-all duration-300 ${getMarginClass()}`}>
        <TopBar
          isSidebarOpen={isSidebarOpen}
          isMobile={isMobile}
          toggleSidebar={toggleSidebar}
          onOpenSearch={openSearch}
        />

        {/* Persistent trial-state banner. Renders nothing for paying customers,
            operators, or while /auth/me is in flight — see TrialBanner.jsx. */}
        <TrialBanner />

        {/* Web Push status banner — only renders for operators on a supported
            browser whose permission is "default" (offer to enable), "denied"
            (recovery instructions), or "granted" with a subscription error
            (offer retry). Returns null on the happy path. */}
        <PushPermissionBanner push={push} />

        {/* `scrollbar-gutter: stable` reserves the scrollbar track even
            when the page isn't scrollable, so switching between tabs
            whose content height differs (e.g. Avatar → Messages in the
            Appearance editor) doesn't shift the entire layout by ~15px
            as the scrollbar appears/disappears. */}
        <main
          className="flex-1 p-4 md:p-6 lg:p-8 overflow-y-auto min-h-0"
          style={{ scrollbarGutter: 'stable' }}
        >
          <div className="max-w-7xl mx-auto h-full">
            <AnimatePresence mode="wait">
              <motion.div
                key={location.pathname}
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="h-full"
              >
                <Outlet />
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>

      <CommandPalette isOpen={searchOpen} onClose={() => setSearchOpen(false)} />

      {showOnboarding && (
        <OnboardingWizard
          onComplete={() => setShowOnboarding(false)}
          onRefreshBots={refreshBots}
        />
      )}

      {/* Floating right-edge feedback tab */}
      <button
        onClick={() => {
          setFeedbackTab('send');
          setFeedbackHighlightId(null);
          setFeedbackOpen(true);
        }}
        aria-label="Send feedback"
        title="Send feedback"
        className="fixed right-0 top-1/2 -translate-y-1/2 hover:translate-x-[-4px] hover:brightness-110 active:brightness-95 transition-all duration-300 ease-in-out flex flex-col items-center justify-center gap-3.5 py-6 w-[44px] rounded-l-2xl rounded-r-none bg-gradient-to-b from-[#6d6bfa] to-[#3b32b3] shadow-[-6px_0_30px_rgba(99,102,241,0.5)] z-40 cursor-pointer"
      >
        <MessageCircle size={20} className="text-white flex-shrink-0" />
        <span
          className="text-white font-semibold tracking-[0.08em] text-[13px] select-none"
          style={{
            writingMode: 'vertical-lr',
            transform: 'rotate(360deg)',
            whiteSpace: 'nowrap',
          }}
        >
          Feedback
        </span>
      </button>

      <FeedbackModal
        key={feedbackOpen ? `feedback-${feedbackTab}` : 'feedback-closed'}
        isOpen={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        onSubmit={handleFeedbackSubmit}
        defaultTab={feedbackTab}
        highlightId={feedbackHighlightId}
      />

      {/* Floating in-app banner for incoming live-chat handoffs. Suppresses
          itself on /support so the live-chat console isn't covered by a
          redundant alert. */}
      <LiveChatRequestBanner />
    </div>
  );
}

export default function AdminLayout() {
  return (
    <NotificationProvider>
      <BotProvider>
        <PushProvider>
          <AdminLayoutInner />
        </PushProvider>
      </BotProvider>
    </NotificationProvider>
  );
}
