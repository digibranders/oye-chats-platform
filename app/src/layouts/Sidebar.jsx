import { useState, useRef, useEffect } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
    LayoutDashboard,
    BookOpen,
    BarChart3,
    MessageCircle,
    ThumbsUp,
    Target,
    Headphones,
    Bot,
    Palette,
    ChevronDown,
    Plus,
    Check,
    Settings,
    Plug,
    Inbox,
    UsersRound,
    MessageSquareText,
} from 'lucide-react';
import { useBotContext } from '../context/BotContext';

export default function Sidebar({ isOpen, isMobile, onClose }) {
    const location = useLocation();
    const { bots, selectedBot, selectBot, loading } = useBotContext();
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const dropdownRef = useRef(null);

    useEffect(() => {
        const handler = (e) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
                setDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    // Close sidebar on nav click on mobile
    const handleNavClick = () => {
        if (isMobile && onClose) onClose();
    };

    const navigate = useNavigate();

    const handleCreateBot = () => {
        setDropdownOpen(false);
        navigate('/chatbot?create=true');
    };

    const isAgentRole = localStorage.getItem('auth_type') === 'agent';

    // Agent users see a minimal sidebar
    const mainItems = isAgentRole
        ? [
            { path: '/live-chat', name: 'Live Chat', icon: Headphones },
            { path: '/messages', name: 'Messages', icon: Inbox },
        ]
        : [
            { path: '/', name: 'Overview', icon: LayoutDashboard },
            { path: '/knowledge', name: 'Sources', icon: BookOpen },
            { path: '/analytics', name: 'Analytics', icon: BarChart3 },
            { path: '/leads', name: 'Leads', icon: Target },
            { path: '/live-chat', name: 'Live Chat', icon: Headphones },
            { path: '/messages', name: 'Messages', icon: Inbox },
            { path: '/users', name: 'Conversations', icon: MessageCircle },
            { path: '/feedback', name: 'Feedback', icon: ThumbsUp },
        ];

    const configItems = isAgentRole
        ? [
            { path: '/canned-responses', name: 'Quick Replies', icon: MessageSquareText },
        ]
        : [
            { path: '/chatbot', name: 'My Bots', icon: Bot },
            { path: '/interface', name: 'Appearance', icon: Palette },
            { path: '/team', name: 'Team', icon: UsersRound },
            { path: '/canned-responses', name: 'Quick Replies', icon: MessageSquareText },
            { path: '/integrations/email', name: 'Integrations', icon: Plug },
        ];

    const isActive = (item) =>
        location.pathname === item.path ||
        (item.path !== '/' && location.pathname.startsWith(item.path));

    const renderLink = (item) => {
        const Icon = item.icon;
        const active = isActive(item);
        return (
            <NavLink
                key={item.path}
                to={item.path}
                onClick={handleNavClick}
                className={`relative flex items-center gap-3 px-3 py-2 rounded-lg transition-all group ${
                    isOpen ? 'w-full' : 'w-10 h-10 justify-center'
                } ${
                    active
                        ? 'bg-white/[0.08] text-white'
                        : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
                }`}
                title={!isOpen ? item.name : undefined}
            >
                {active && (
                    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-primary-500 rounded-r-full" />
                )}
                <Icon
                    size={18}
                    className={`flex-shrink-0 ${active ? 'text-primary-400' : 'text-zinc-500 group-hover:text-zinc-300'}`}
                />
                {isOpen && (
                    <span className="truncate text-[13px] font-medium">{item.name}</span>
                )}
            </NavLink>
        );
    };

    const adminName = localStorage.getItem('admin_name') || 'User';

    // Mobile: slide-in overlay. Desktop/tablet: fixed sidebar.
    const sidebarClasses = isMobile
        ? `fixed top-0 left-0 h-screen bg-zinc-950 z-30 transition-transform duration-300 flex flex-col w-60 ${
            isOpen ? 'translate-x-0' : '-translate-x-full'
        }`
        : `fixed top-0 left-0 h-screen overflow-hidden bg-zinc-950 z-30 transition-all duration-300 flex flex-col ${
            isOpen ? 'w-60' : 'w-[68px]'
        }`;

    return (
        <aside className={sidebarClasses}>
            {/* Logo */}
            <div className="flex items-center h-16 px-4 shrink-0">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 text-white flex items-center justify-center flex-shrink-0 shadow-lg shadow-primary-500/20">
                        <Bot size={20} />
                    </div>
                    {isOpen && (
                        <span className="text-[15px] font-bold text-white tracking-tight">
                            OyeChat
                        </span>
                    )}
                </div>
            </div>

            {/* Bot Selector */}
            {isOpen && (
                <div className="px-3 pb-2" ref={dropdownRef}>
                    {bots.length === 0 && !loading ? (
                        <NavLink
                            to="/chatbot"
                            onClick={handleNavClick}
                            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border border-dashed border-zinc-700 bg-zinc-900/50 hover:bg-zinc-800 transition-all text-left"
                        >
                            <div className="w-6 h-6 rounded-md bg-primary-500/10 flex items-center justify-center flex-shrink-0">
                                <Plus size={13} className="text-primary-400" />
                            </div>
                            <p className="text-[12px] font-semibold text-primary-400 truncate">
                                Create a Chatbot
                            </p>
                        </NavLink>
                    ) : (
                        <div className="relative">
                            <button
                                onClick={() => setDropdownOpen(!dropdownOpen)}
                                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-zinc-900/80 border border-zinc-800 hover:border-zinc-700 transition-all text-left group"
                            >
                                <div className="w-6 h-6 rounded-md bg-primary-500/15 flex items-center justify-center flex-shrink-0">
                                    <Bot size={13} className="text-primary-400" />
                                </div>
                                <p className="text-[12px] font-semibold text-zinc-200 truncate flex-1">
                                    {loading ? 'Loading...' : (selectedBot?.name || 'Select a Bot')}
                                </p>
                                <ChevronDown size={14} className={`text-zinc-500 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
                            </button>

                            {dropdownOpen && (
                                <div className="absolute left-0 right-0 mt-1 bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl overflow-hidden z-50">
                                    <div className="max-h-48 overflow-y-auto py-1">
                                        {bots.map((bot) => (
                                            <button
                                                key={bot.id}
                                                onClick={() => { selectBot(bot); setDropdownOpen(false); }}
                                                className={`w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-zinc-800 transition-colors ${
                                                    selectedBot?.id === bot.id ? 'bg-zinc-800/50' : ''
                                                }`}
                                            >
                                                <div className="w-5 h-5 rounded-md bg-zinc-800 flex items-center justify-center flex-shrink-0">
                                                    <Bot size={11} className="text-zinc-400" />
                                                </div>
                                                <span className="text-[12px] font-medium text-zinc-300 truncate flex-1">{bot.name}</span>
                                                {selectedBot?.id === bot.id && <Check size={13} className="text-primary-400 flex-shrink-0" />}
                                            </button>
                                        ))}
                                    </div>
                                    <div className="border-t border-zinc-800">
                                        <button
                                            onClick={handleCreateBot}
                                            className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-primary-400 hover:bg-zinc-800 transition-colors"
                                        >
                                            <Plus size={13} />
                                            Create new bot
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Collapsed bot indicator */}
            {!isOpen && !isMobile && (
                <div className="flex justify-center pb-2">
                    {selectedBot ? (
                        <div className="w-9 h-9 rounded-lg bg-primary-500/10 flex items-center justify-center cursor-pointer" title={selectedBot.name}>
                            <Bot size={15} className="text-primary-400" />
                        </div>
                    ) : (
                        <NavLink to="/chatbot" className="w-9 h-9 rounded-lg bg-zinc-900 border border-dashed border-zinc-700 flex items-center justify-center" title="Create a chatbot">
                            <Plus size={15} className="text-zinc-500" />
                        </NavLink>
                    )}
                </div>
            )}

            {/* Navigation */}
            <nav className="flex-1 overflow-y-auto px-3 space-y-1 mt-2">
                {isOpen && <p className="px-3 pt-2 pb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-600">Main</p>}
                {mainItems.map(renderLink)}

                <div className="pt-4">
                    {isOpen && <p className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-600">Configure</p>}
                    {!isOpen && !isMobile && <div className="border-t border-zinc-800 mb-2 mx-2" />}
                    {configItems.map(renderLink)}
                </div>
            </nav>

            {/* Bottom: User + Settings */}
            <div className="shrink-0 p-3 border-t border-zinc-800/50">
                <NavLink
                    to="/settings"
                    onClick={handleNavClick}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all group ${
                        isOpen ? 'w-full' : 'w-10 h-10 justify-center'
                    } ${
                        location.pathname === '/settings'
                            ? 'bg-white/[0.08] text-white'
                            : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
                    }`}
                    title={!isOpen ? 'Settings' : undefined}
                >
                    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-white flex items-center justify-center flex-shrink-0 text-[11px] font-bold">
                        {adminName.charAt(0).toUpperCase()}
                    </div>
                    {isOpen && (
                        <div className="flex-1 min-w-0">
                            <p className="text-[12px] font-medium text-zinc-200 truncate">{adminName}</p>
                            <p className="text-[10px] text-zinc-500">Settings</p>
                        </div>
                    )}
                    {isOpen && <Settings size={14} className="text-zinc-500" />}
                </NavLink>
            </div>
        </aside>
    );
}
