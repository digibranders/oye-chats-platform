import { NavLink, useLocation } from 'react-router-dom';
import {
    Activity,
    Users as UsersIcon,
    Sparkles,
    MessageSquareQuote,
    PanelLeftClose,
    PanelLeftOpen,
} from 'lucide-react';
import { cn } from '../lib/utils';
import SettingsDropup from '../components/SettingsDropup';

export default function SuperadminSidebar({ isOpen, setIsOpen }) {
    const location = useLocation();

    const menuItems = [
        { path: '/superadmin/overview', name: 'Global Overview', icon: Activity },
        { path: '/superadmin/clients', name: 'Manage Clients', icon: UsersIcon },
        { path: '/superadmin/feedback', name: 'Global Feedback', icon: MessageSquareQuote },
    ];


    const isActive = (item) =>
        location.pathname === item.path ||
        (item.path !== '/superadmin' && location.pathname.startsWith(item.path));

    const renderLink = (item) => {
        const Icon = item.icon;
        const active = isActive(item);
        return (
            <NavLink
                key={item.path}
                to={item.path}
                className={cn(
                    'flex items-center gap-3 px-3 rounded-xl transition-all group',
                    isOpen ? 'w-full h-8' : 'w-8 h-8 justify-center',
                    active
                        ? 'bg-surface-100 text-surface-900 dark:bg-white/[0.08] dark:text-white'
                        : 'text-surface-500 hover:bg-surface-100 hover:text-surface-700 dark:text-surface-400 dark:hover:bg-white/[0.05] dark:hover:text-surface-200'
                )}
                title={!isOpen ? item.name : undefined}
            >
                <Icon
                    size={18}
                    className={cn(
                        'flex-shrink-0 transition-colors',
                        active
                            ? 'text-primary-600 dark:text-primary-400'
                            : 'text-surface-400 group-hover:text-surface-600 dark:text-surface-500 dark:group-hover:text-surface-300'
                    )}
                />
                {isOpen && <span className="truncate text-sm">{item.name}</span>}
                {active && isOpen && (
                    <div className="ml-auto w-1.5 h-1.5 rounded-full bg-primary-500 flex-shrink-0"></div>
                )}
            </NavLink>
        );
    };

    return (
        <aside
            className={cn(
                'fixed top-0 left-0 h-screen overflow-x-hidden bg-white dark:bg-surface-950 border-r border-surface-200 dark:border-surface-800/50 z-20 transition-all duration-300',
                isOpen ? 'w-[14.5rem]' : 'w-20'
            )}
        >
            {/* Logo */}
            <div className="flex items-center justify-center h-16 border-b border-surface-200 dark:border-surface-800/50">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 text-white flex items-center justify-center flex-shrink-0 shadow-lg shadow-primary-500/25">
                        <Sparkles size={18} />
                    </div>
                    {isOpen && (
                        <span className="text-[15px] font-bold text-surface-900 dark:text-white tracking-tight truncate pr-4">
                            Superadmin
                        </span>
                    )}
                </div>
            </div>

            <nav className="p-4 space-y-1 mt-2 overflow-y-auto h-[calc(100vh-8rem)]">
                {/* Main Nav */}
                {menuItems.map(renderLink)}


            </nav>

            <div className="absolute bottom-4 left-0 w-full px-4 space-y-2">
                <SettingsDropup isOpen={isOpen} />
                <button
                    onClick={() => setIsOpen(prev => !prev)}
                    className={cn(
                        'flex items-center gap-2 w-full px-3 py-2 rounded-xl text-surface-500 hover:bg-surface-100 hover:text-surface-700 dark:text-surface-400 dark:hover:bg-white/[0.05] dark:hover:text-surface-200 transition-all',
                        !isOpen && 'justify-center'
                    )}
                    title={isOpen ? 'Collapse sidebar' : 'Expand sidebar'}
                >
                    {isOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
                    {isOpen && <span className="text-sm">Collapse</span>}
                </button>
            </div>
        </aside>
    );
}
