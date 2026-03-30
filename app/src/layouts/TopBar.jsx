import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, LogOut, Menu, PanelLeftClose } from 'lucide-react';
import Breadcrumbs from '../components/Breadcrumbs';

export default function TopBar({ isSidebarOpen, isMobile, toggleSidebar, onOpenSearch }) {
    const navigate = useNavigate();
    const adminName = localStorage.getItem('admin_name') || 'Admin';
    const [showUserMenu, setShowUserMenu] = useState(false);

    const handleLogout = () => {
        localStorage.removeItem('admin_token');
        localStorage.removeItem('admin_name');
        localStorage.removeItem('admin_client_id');
        navigate('/login');
    };

    return (
        <header className="h-14 bg-white/80 backdrop-blur-xl border-b border-secondary-200/60 px-3 md:px-6 flex items-center justify-between sticky top-0 z-20 transition-colors">
            {/* Left: Sidebar toggle + Breadcrumbs */}
            <div className="flex items-center gap-2 md:gap-3 min-w-0">
                <button
                    onClick={toggleSidebar}
                    className="p-1.5 rounded-lg text-secondary-400 hover:text-secondary-600 hover:bg-secondary-100 transition-colors shrink-0"
                    title={isSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
                >
                    {isSidebarOpen && !isMobile ? <PanelLeftClose size={18} /> : <Menu size={18} />}
                </button>
                <div className="min-w-0 truncate">
                    <Breadcrumbs />
                </div>
            </div>

            {/* Center: Search — full on desktop, icon-only on mobile */}
            <button
                onClick={onOpenSearch}
                className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-secondary-100 border border-secondary-200 rounded-lg text-secondary-400 hover:border-secondary-300 transition-colors text-sm cursor-pointer"
            >
                <Search size={14} />
                <span className="text-[13px]">Search...</span>
                <kbd className="ml-4 px-1.5 py-0.5 bg-secondary-200 rounded text-[10px] font-semibold text-secondary-500">
                    ⌘K
                </kbd>
            </button>

            {/* Right: Search icon (mobile) + User */}
            <div className="flex items-center gap-1 md:gap-2">
                {/* Mobile search icon */}
                <button
                    onClick={onOpenSearch}
                    className="md:hidden p-2 rounded-lg text-secondary-400 hover:text-secondary-600 hover:bg-secondary-100 transition-colors"
                >
                    <Search size={16} />
                </button>

                <div className="relative">
                    <button
                        onClick={() => setShowUserMenu(!showUserMenu)}
                        onBlur={() => setTimeout(() => setShowUserMenu(false), 150)}
                        className="flex items-center gap-2 p-1 rounded-lg hover:bg-secondary-100 transition-colors"
                    >
                        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 text-white flex items-center justify-center font-bold text-xs shadow-sm">
                            {adminName.charAt(0).toUpperCase()}
                        </div>
                        <span className="hidden md:block text-[13px] font-medium text-secondary-700 max-w-[100px] truncate">
                            {adminName}
                        </span>
                    </button>

                    {showUserMenu && (
                        <div className="absolute right-0 mt-1 w-48 bg-white border border-secondary-200 rounded-xl shadow-lg z-50 animate-scale-in origin-top-right">
                            <div className="px-4 py-3 border-b border-secondary-100">
                                <p className="text-sm font-medium text-secondary-900">{adminName}</p>
                                <p className="text-xs text-secondary-400 mt-0.5">Manage account</p>
                            </div>
                            <div className="p-1">
                                <button
                                    onClick={handleLogout}
                                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-error-600 hover:bg-error-50 rounded-lg transition-colors font-medium"
                                >
                                    <LogOut size={14} />
                                    Sign out
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </header>
    );
}
