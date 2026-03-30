import { useState, useEffect, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import Toast from '../components/Toast';
import CommandPalette from '../components/CommandPalette';
import OnboardingWizard from '../components/OnboardingWizard';
import { BotProvider, useBotContext } from '../context/BotContext';

const MD_BREAKPOINT = 768;
const LG_BREAKPOINT = 1024;

function AdminLayoutInner() {
    const [isSidebarOpen, setIsSidebarOpen] = useState(() => window.innerWidth >= LG_BREAKPOINT);
    const [isMobile, setIsMobile] = useState(() => window.innerWidth < MD_BREAKPOINT);
    const [showLoginToast, setShowLoginToast] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [showOnboarding, setShowOnboarding] = useState(false);
    const { bots, loading: botsLoading, refreshBots } = useBotContext();

    // Responsive resize handler
    useEffect(() => {
        const handleResize = () => {
            const w = window.innerWidth;
            const nowMobile = w < MD_BREAKPOINT;
            setIsMobile(nowMobile);
            if (nowMobile) {
                setIsSidebarOpen(false);
            } else if (w >= LG_BREAKPOINT) {
                setIsSidebarOpen(true);
            } else {
                // tablet — collapsed
                setIsSidebarOpen(false);
            }
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    useEffect(() => {
        if (sessionStorage.getItem('login_toast')) {
            sessionStorage.removeItem('login_toast');
            setTimeout(() => {
                setShowLoginToast(true);
                setTimeout(() => setShowLoginToast(false), 2500);
            }, 0);
        }
    }, []);

    // Show onboarding when bots finish loading and none exist
    useEffect(() => {
        if (!botsLoading && bots.length === 0 && !localStorage.getItem('onboarding_complete')) {
            setShowOnboarding(true); // eslint-disable-line react-hooks/set-state-in-effect -- one-time init from external state (localStorage)
        }
    }, [botsLoading, bots.length]);

    // Cmd+K handler
    useEffect(() => {
        const handler = (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                setSearchOpen(true);
            }
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, []);

    const toggleSidebar = useCallback(() => setIsSidebarOpen(prev => !prev), []);
    const closeSidebar = useCallback(() => setIsSidebarOpen(false), []);
    const openSearch = useCallback(() => setSearchOpen(true), []);

    // Compute main content margin
    const getMarginClass = () => {
        if (isMobile) return 'ml-0'; // sidebar overlays on mobile
        if (isSidebarOpen) return 'ml-60';
        return 'ml-[68px]';
    };

    return (
        <div className="min-h-screen bg-secondary-50 flex">
            {/* Mobile backdrop */}
            {isMobile && isSidebarOpen && (
                <div
                    className="fixed inset-0 bg-black/50 backdrop-blur-sm z-20 animate-fade-in"
                    onClick={closeSidebar}
                />
            )}

            <Sidebar
                isOpen={isSidebarOpen}
                isMobile={isMobile}
                onClose={closeSidebar}
            />

            <div className={`flex-1 flex flex-col transition-all duration-300 ${getMarginClass()}`}>
                <TopBar
                    isSidebarOpen={isSidebarOpen}
                    isMobile={isMobile}
                    toggleSidebar={toggleSidebar}
                    onOpenSearch={openSearch}
                />

                <main className="flex-1 p-4 md:p-6 lg:p-8 overflow-y-auto">
                    <div className="max-w-7xl mx-auto animate-fade-in">
                        <Outlet />
                    </div>
                </main>
            </div>

            <Toast />
            <CommandPalette isOpen={searchOpen} onClose={() => setSearchOpen(false)} />

            {showOnboarding && (
                <OnboardingWizard
                    onComplete={() => setShowOnboarding(false)}
                    onRefreshBots={refreshBots}
                />
            )}

            <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-[110] flex items-center gap-2 bg-white shadow-lg border border-secondary-200 rounded-full px-4 py-2 text-sm font-medium text-secondary-800 transition-all duration-500 ${
                showLoginToast ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-3 pointer-events-none'
            }`}>
                <span className="w-2.5 h-2.5 rounded-full bg-success-500 flex-shrink-0" />
                Login successful!
            </div>
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
