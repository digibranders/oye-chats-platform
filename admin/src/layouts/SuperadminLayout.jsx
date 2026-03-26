import { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import SuperadminSidebar from './SuperadminSidebar';
import TopBar from './TopBar';

export default function SuperadminLayout() {
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [showLoginToast, setShowLoginToast] = useState(false);

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
        <div className="min-h-screen bg-secondary-50 dark:bg-secondary-900 flex">
            {/* Sidebar */}
            <SuperadminSidebar isOpen={isSidebarOpen} setIsOpen={setIsSidebarOpen} />

            {/* Main Content Area */}
            <div className={`flex-1 flex flex-col transition-all duration-300 ${isSidebarOpen ? 'ml-[14.5rem]' : 'ml-20'}`}>
                <TopBar />

                <main className="flex-1 p-6 md:p-8 overflow-y-auto">
                    <div className="max-w-7xl mx-auto">
                        <Outlet />
                    </div>
                </main>
            </div>

            {/* Login success pill toast — top center */}
            <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-white dark:bg-secondary-800 shadow-lg border border-secondary-100 dark:border-secondary-700 rounded-full px-4 py-2 text-sm font-medium text-secondary-800 dark:text-white transition-all duration-500 ${showLoginToast ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-3 pointer-events-none'
                }`}>
                <span className="w-2.5 h-2.5 rounded-full bg-green-500 flex-shrink-0"></span>
                Login successful!
            </div>
        </div>
    );
}
