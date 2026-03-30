import { NavLink, useLocation } from 'react-router-dom';
import {
    Activity,
    Users as UsersIcon,
    Bot,
    Settings,
    MessageSquareQuote
} from 'lucide-react';
import SettingsDropup from '../components/SettingsDropup';

export default function SuperadminSidebar({ isOpen }) {
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
                className={`flex items-center gap-3 px-3 rounded-xl transition-all group ${isOpen ? 'w-full h-8' : 'w-8 h-8 justify-center'
                    } ${active
                        ? 'bg-primary-50 text-primary-700 font-medium'
                        : 'text-secondary-600 hover:bg-secondary-50:bg-secondary-700/50 hover:text-secondary-900:text-secondary-200'
                    }`}
                title={!isOpen ? item.name : undefined}
            >
                <Icon
                    size={18}
                    className={`flex-shrink-0 transition-colors ${active
                        ? 'text-primary-600'
                        : 'text-secondary-400 group-hover:text-secondary-600:text-secondary-300'
                        }`}
                />
                {isOpen && <span className="truncate text-sm">{item.name}</span>}
                {active && isOpen && (
                    <div className="ml-auto w-1.5 h-1.5 rounded-full bg-primary-600 flex-shrink-0"></div>
                )}
            </NavLink>
        );
    };

    return (
        <aside
            className={`fixed top-0 left-0 h-screen overflow-x-hidden bg-white border-r border-secondary-200 shadow-sm z-20 transition-all duration-300 ${isOpen ? 'w-58' : 'w-20'
                }`}
        >
            {/* Logo */}
            <div className="flex items-center justify-center h-16 border-b border-secondary-100">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center flex-shrink-0 shadow-md">
                        <Bot size={20} />
                    </div>
                    {isOpen && (
                        <span className="text-l font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-600 to-indigo-900 truncate pr-4">
                            Superadmin
                        </span>
                    )}
                </div>
            </div>

            <nav className="p-4 space-y-1 mt-2 overflow-y-auto h-[calc(100vh-8rem)]">
                {/* Main Nav */}
                {menuItems.map(renderLink)}


            </nav>

            <div className="absolute bottom-4 left-0 w-full px-4">
                <SettingsDropup isOpen={isOpen} />
            </div>
        </aside>
    );
}
