import { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import SuperadminSidebar from './SuperadminSidebar';
import TopBar from './TopBar';

const pageVariants = {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] } },
    exit: { opacity: 0, y: -4, transition: { duration: 0.15 } },
};

export default function SuperadminLayout() {
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [showLoginToast, setShowLoginToast] = useState(false);
    const location = useLocation();

    useEffect(() => {
        if (sessionStorage.getItem('login_toast')) {
            sessionStorage.removeItem('login_toast');
            setTimeout(() => {
                setShowLoginToast(true);
                setTimeout(() => setShowLoginToast(false), 2500);
            }, 0);
        }
    }, []);

    return (
        <div className="min-h-screen bg-surface-50 dark:bg-surface-950 flex transition-colors duration-300">
            {/* Sidebar */}
            <SuperadminSidebar isOpen={isSidebarOpen} setIsOpen={setIsSidebarOpen} />

            {/* Main Content Area */}
            <div className={`flex-1 flex flex-col transition-all duration-300 ${isSidebarOpen ? 'ml-[14.5rem]' : 'ml-20'}`}>
                <TopBar
                    isSidebarOpen={isSidebarOpen}
                    isMobile={false}
                    toggleSidebar={() => setIsSidebarOpen(prev => !prev)}
                    onOpenSearch={() => {}}
                />

                <main className="flex-1 p-6 md:p-8 overflow-y-auto">
                    <div className="max-w-7xl mx-auto">
                        <AnimatePresence mode="wait">
                            <motion.div
                                key={location.pathname}
                                variants={pageVariants}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                            >
                                <Outlet />
                            </motion.div>
                        </AnimatePresence>
                    </div>
                </main>
            </div>

            {/* Login success pill toast — top center */}
            <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-white dark:bg-surface-800 shadow-lg border border-surface-100 dark:border-surface-700 rounded-full px-4 py-2 text-sm font-medium text-surface-800 dark:text-surface-200 transition-all duration-500 ${showLoginToast ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-3 pointer-events-none'
                }`}>
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 flex-shrink-0"></span>
                Login successful!
            </div>
        </div>
    );
}
