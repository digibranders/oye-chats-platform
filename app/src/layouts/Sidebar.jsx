import { useState, useRef, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
    LayoutDashboard,
    Database,
    Palette,
    BarChart2,
    Users as UsersIcon,
    MessageCircle,
    Bot,
    ChevronDown,
    Plus,
    Check,
    Loader2,
    Code2
} from 'lucide-react';
import SettingsDropup from '../components/SettingsDropup';
import { useBotContext } from '../context/BotContext';
import { createBot } from '../services/api';

export default function Sidebar({ isOpen }) {
    const location = useLocation();
    const { bots, selectedBot, selectBot, refreshBots, loading } = useBotContext();
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [creating, setCreating] = useState(false);
    const dropdownRef = useRef(null);

    // Close dropdown on outside click
    useEffect(() => {
        const handler = (e) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
                setDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const handleCreateBot = async () => {
        try {
            setCreating(true);
            await createBot({ name: `Bot ${bots.length + 1}` });
            await refreshBots();
            setDropdownOpen(false);
        } catch (err) {
            alert(typeof err === 'string' ? err : err?.detail || 'Failed to create bot');
        } finally {
            setCreating(false);
        }
    };

    const menuItems = [
        { path: '/admin', name: 'Dashboard', icon: LayoutDashboard },
        { path: '/admin/knowledge', name: 'Knowledge Base', icon: Database },
        { path: '/admin/analytics', name: 'Analytics', icon: BarChart2 },
        { path: '/admin/users', name: 'Visitors', icon: UsersIcon },
        { path: '/admin/feedback', name: 'Feedback', icon: MessageCircle },
    ];

    const customizeItems = [
        { path: '/admin/chatbot', name: 'Chatbot', icon: Code2 },
        { path: '/admin/interface', name: 'Interface', icon: Palette },
    ];

    const isActive = (item) =>
        location.pathname === item.path ||
        (item.path !== '/admin' && location.pathname.startsWith(item.path));

    const renderLink = (item) => {
        const Icon = item.icon;
        const active = isActive(item);
        return (
            <NavLink
                key={item.path}
                to={item.path}
                className={`flex items-center gap-3 px-3 rounded-xl transition-all group ${isOpen ? 'w-full h-8' : 'w-8 h-8 justify-center'
                    } ${active
                        ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 font-medium'
                        : 'text-secondary-600 dark:text-secondary-400 hover:bg-secondary-50 dark:hover:bg-secondary-700/50 hover:text-secondary-900 dark:hover:text-secondary-200'
                    }`}
                title={!isOpen ? item.name : undefined}
            >
                <Icon
                    size={18}
                    className={`flex-shrink-0 transition-colors ${active
                        ? 'text-primary-600 dark:text-primary-400'
                        : 'text-secondary-400 dark:text-secondary-500 group-hover:text-secondary-600 dark:group-hover:text-secondary-300'
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
            className={`fixed top-0 left-0 h-screen overflow-x-hidden bg-white dark:bg-secondary-800 border-r border-secondary-200 dark:border-secondary-700 shadow-sm z-20 transition-all duration-300 ${isOpen ? 'w-58' : 'w-20'
                }`}
        >
            {/* Logo */}
            <div className="flex items-center justify-center h-16 border-b border-secondary-100 dark:border-secondary-700">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-primary-600 dark:bg-primary-500 text-white flex items-center justify-center flex-shrink-0 shadow-md">
                        <Bot size={20} />
                    </div>
                    {isOpen && (
                        <span className="text-l font-bold bg-clip-text text-transparent bg-gradient-to-r from-primary-600 to-primary-900 dark:from-primary-400 dark:to-primary-200 truncate">
                            Admin Dashboard
                        </span>
                    )}
                </div>
            </div>

            {/* Bot Selector */}
            {isOpen && (
                <div className="px-3 pt-3 pb-1" ref={dropdownRef}>
                    {bots.length === 0 && !loading ? (
                        /* Empty state — no bots yet */
                        <NavLink
                            to="/admin/chatbot"
                            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border border-dashed border-primary-300 dark:border-primary-700 bg-primary-50/50 dark:bg-primary-900/10 hover:bg-primary-100 dark:hover:bg-primary-900/20 transition-all text-left"
                        >
                            <div className="w-6 h-6 rounded-md bg-primary-100 dark:bg-primary-900/40 flex items-center justify-center flex-shrink-0">
                                <Plus size={13} className="text-primary-600 dark:text-primary-400" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-[12px] font-semibold text-primary-600 dark:text-primary-400 truncate">
                                    Create a Chatbot
                                </p>
                            </div>
                        </NavLink>
                    ) : (
                        <>
                            <button
                                onClick={() => setDropdownOpen(!dropdownOpen)}
                                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border border-secondary-200 dark:border-secondary-700 bg-secondary-50 dark:bg-secondary-800/50 hover:bg-secondary-100 dark:hover:bg-secondary-700 transition-all text-left group"
                            >
                                <div className="w-6 h-6 rounded-md bg-primary-100 dark:bg-primary-900/40 flex items-center justify-center flex-shrink-0">
                                    <Bot size={13} className="text-primary-600 dark:text-primary-400" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-[12px] font-semibold text-secondary-800 dark:text-secondary-200 truncate">
                                        {loading ? 'Loading...' : (selectedBot?.name || 'Select a Bot')}
                                    </p>
                                </div>
                                <ChevronDown size={14} className={`text-secondary-400 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
                            </button>

                            {/* Dropdown */}
                            {dropdownOpen && (
                                <div className="mt-1 bg-white dark:bg-secondary-800 border border-secondary-200 dark:border-secondary-700 rounded-xl shadow-lg overflow-hidden z-50 relative">
                                    <div className="max-h-48 overflow-y-auto py-1">
                                        {bots.map((bot) => (
                                            <button
                                                key={bot.id}
                                                onClick={() => {
                                                    selectBot(bot);
                                                    setDropdownOpen(false);
                                                }}
                                                className={`w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-secondary-50 dark:hover:bg-secondary-700/50 transition-colors ${
                                                    selectedBot?.id === bot.id ? 'bg-primary-50/50 dark:bg-primary-900/20' : ''
                                                }`}
                                            >
                                                <div className="w-5 h-5 rounded-md bg-secondary-100 dark:bg-secondary-700 flex items-center justify-center flex-shrink-0">
                                                    <Bot size={11} className="text-secondary-500" />
                                                </div>
                                                <span className="text-[12px] font-medium text-secondary-700 dark:text-secondary-300 truncate flex-1">
                                                    {bot.name}
                                                </span>
                                                {selectedBot?.id === bot.id && (
                                                    <Check size={13} className="text-primary-600 dark:text-primary-400 flex-shrink-0" />
                                                )}
                                            </button>
                                        ))}
                                    </div>
                                    {/* Create bot button */}
                                    <div className="border-t border-secondary-100 dark:border-secondary-700">
                                        <button
                                            onClick={handleCreateBot}
                                            disabled={creating}
                                            className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-primary-600 dark:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-900/20 transition-colors disabled:opacity-50"
                                        >
                                            {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                                            {creating ? 'Creating...' : 'Create new bot'}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}

            {/* Collapsed bot indicator */}
            {!isOpen && (
                <div className="flex justify-center pt-3 pb-1">
                    {selectedBot ? (
                        <div
                            className="w-8 h-8 rounded-lg bg-primary-100 dark:bg-primary-900/40 flex items-center justify-center cursor-pointer"
                            title={selectedBot.name}
                        >
                            <Bot size={15} className="text-primary-600 dark:text-primary-400" />
                        </div>
                    ) : (
                        <NavLink
                            to="/admin/chatbot"
                            className="w-8 h-8 rounded-lg bg-primary-50 dark:bg-primary-900/20 border border-dashed border-primary-300 dark:border-primary-700 flex items-center justify-center"
                            title="Create a chatbot"
                        >
                            <Plus size={15} className="text-primary-500" />
                        </NavLink>
                    )}
                </div>
            )}

            <nav className="p-4 space-y-1 mt-1 overflow-y-auto h-[calc(100vh-14rem)]">
                {/* Main Nav */}
                {menuItems.map(renderLink)}

                {/* Customize Section */}
                <div className="pt-4">
                    {isOpen && (
                        <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-widest text-secondary-400 dark:text-secondary-500">
                            Customize
                        </p>
                    )}
                    {!isOpen && <div className="border-t border-secondary-100 dark:border-secondary-700 mb-2"></div>}
                    {customizeItems.map(renderLink)}
                </div>
            </nav>

            <div className="absolute bottom-4 left-0 w-full px-4 space-y-2 bg-white dark:bg-secondary-800 z-50">
                <SettingsDropup isOpen={isOpen} />
            </div>
        </aside>
    );
}
