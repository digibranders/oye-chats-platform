import { useState, useEffect, useCallback } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import CommandPalette from '../components/CommandPalette';
import OnboardingWizard from '../components/OnboardingWizard';
import TrialBanner from '../components/TrialBanner';
import { BotProvider, useBotContext } from '../context/BotContext';

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
  const { bots, loading: botsLoading, error: botsError, refreshBots } = useBotContext();
  const location = useLocation();

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
    </div>
  );
}

export default function AdminLayout() {
  return (
    <BotProvider>
      <AdminLayoutInner />
    </BotProvider>
  );
}
