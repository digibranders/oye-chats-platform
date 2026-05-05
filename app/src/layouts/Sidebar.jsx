import { useState, useRef, useEffect } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard, BookOpen, BarChart3, Target, Crosshair, Headphones,
  Bot, ChevronDown, Plus, Check, Settings, Plug, UsersRound, Sparkles, CreditCard,
} from 'lucide-react';
import { useBotContext } from '../context/BotContext';
import { getAuthState } from '../utils/auth';
import { getOfflineMessages, getLeadStats } from '../services/api';
import { cn } from '../lib/utils';

export default function Sidebar({ isOpen, isMobile, onClose }) {
  const location = useLocation();
  const { bots, selectedBot, selectBot, loading, error: botError } = useBotContext();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);
  const navigate = useNavigate();
  const { isOperator: isOperatorRole, isBotManager } = getAuthState();
  const [unreadMsgs, setUnreadMsgs] = useState(0);
  const [newLeads, setNewLeads] = useState(0);

  useEffect(() => {
    const fetchBadges = async () => {
      try {
        const [offlineData, leadsData] = await Promise.allSettled([
          getOfflineMessages({ status: 'new', limit: 1 }),
          getLeadStats(selectedBot?.id),
        ]);
        if (offlineData.status === 'fulfilled') setUnreadMsgs(offlineData.value?.total || 0);
        if (leadsData.status === 'fulfilled') {
          // `unread` = ChatSessions where lead_viewed_at IS NULL.
          // Drops to 0 when the team opens each lead or clicks "Mark all read".
          setNewLeads(leadsData.value?.unread || 0);
        }
      } catch {
        // badges are non-critical
      }
    };
    fetchBadges();
    const interval = setInterval(fetchBadges, 60000);
    return () => clearInterval(interval);
  }, [selectedBot?.id]);

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleNavClick = () => { if (isMobile && onClose) onClose(); };
  const handleCreateBot = () => { setDropdownOpen(false); navigate('/chatbot?create=true'); };

  const mainItems = isOperatorRole
    ? [{ path: '/support', name: 'Support', icon: Headphones, badge: unreadMsgs }]
    : [
        { path: '/', name: 'Overview', icon: LayoutDashboard },
        { path: '/knowledge', name: 'Sources', icon: BookOpen },
        { path: '/insights', name: 'Insights', icon: BarChart3 },
        { path: '/support', name: 'Support', icon: Headphones, badge: unreadMsgs },
        { path: '/leads', name: 'Leads', icon: Target, badge: newLeads },
        { path: '/qualification', name: 'Qualification', icon: Crosshair },
        { path: '/integrations', name: 'Integrations', icon: Plug },
      ];

  const configItems = isOperatorRole
    ? [{ path: '/team', name: 'Team', icon: UsersRound }]
    : [
        { path: '/chatbot', name: 'My Bots', icon: Bot },
        { path: '/team', name: 'Team', icon: UsersRound },
        { path: '/billing', name: 'Billing', icon: CreditCard },
      ];

  const isActive = (item) =>
    location.pathname === item.path ||
    (item.path !== '/' && location.pathname.startsWith(item.path));

  const renderLink = (item, index) => {
    const Icon = item.icon;
    const active = isActive(item);
    const hasBadge = item.badge > 0;
    return (
      <motion.div
        key={item.path}
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.2, delay: index * 0.03 }}
      >
        <NavLink
          to={item.path}
          onClick={handleNavClick}
          className={cn(
            'relative flex items-center gap-3 px-3 py-2 rounded-xl transition-all duration-200 group',
            isOpen ? 'w-full' : 'w-10 h-10 justify-center',
            active
              ? 'bg-primary-50 dark:bg-white/[0.08] text-primary-700 dark:text-white'
              : 'text-surface-500 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-white/[0.05] hover:text-surface-700 dark:hover:text-surface-200'
          )}
          title={!isOpen ? item.name : undefined}
          aria-label={item.name}
        >
          {active && (
            <motion.div
              layoutId="sidebar-active"
              className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-primary-500 rounded-r-full"
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            />
          )}
          <div className="relative flex-shrink-0">
            <Icon
              size={18}
              className={cn(
                'transition-colors',
                active ? 'text-primary-500 dark:text-primary-400' : 'text-surface-400 dark:text-surface-500 group-hover:text-surface-600 dark:group-hover:text-surface-300'
              )}
            />
            {hasBadge && !isOpen && (
              <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-rose-500 rounded-full text-[8px] text-white flex items-center justify-center font-bold leading-none">
                {item.badge > 9 ? '9+' : item.badge}
              </span>
            )}
          </div>
          {isOpen && (
            <>
              <span className="truncate text-[13px] font-medium flex-1">{item.name}</span>
              {hasBadge && (
                <span className="ml-auto min-w-[18px] h-[18px] px-1 bg-rose-500 rounded-full text-[10px] text-white flex items-center justify-center font-bold leading-none">
                  {item.badge > 99 ? '99+' : item.badge}
                </span>
              )}
            </>
          )}
        </NavLink>
      </motion.div>
    );
  };

  const sidebarClasses = isMobile
    ? cn(
        'fixed top-0 left-0 h-screen z-30 flex flex-col w-60 transition-transform duration-300',
        isOpen ? 'translate-x-0' : '-translate-x-full'
      )
    : cn(
        'fixed top-0 left-0 h-screen overflow-hidden z-30 transition-all duration-300 flex flex-col',
        isOpen ? 'w-60' : 'w-[68px]'
      );

  return (
    <aside className={cn(sidebarClasses, 'bg-white dark:bg-surface-950 border-r border-surface-200 dark:border-surface-800/50')}>
      {/* Logo */}
      <div className="flex items-center h-16 px-4 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 text-white flex items-center justify-center flex-shrink-0 shadow-lg shadow-primary-500/25">
            <Sparkles size={18} />
          </div>
          {isOpen && (
            <motion.span
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              className="text-[15px] font-bold text-surface-900 dark:text-white tracking-tight"
            >
              {localStorage.getItem('company_name') || 'OyeChats'}
            </motion.span>
          )}
        </div>
      </div>

      {/* Bot Selector */}
      {isOpen && (
        <div className="px-3 pb-2" ref={dropdownRef}>
          {loading ? (
            <div className="h-9 rounded-lg bg-surface-100 dark:bg-surface-800 animate-pulse" />
          ) : botError ? (
            <div className="w-full rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2">
              <p className="text-[11px] font-semibold text-amber-300">Bots unavailable</p>
              <p className="mt-1 text-[10px] text-amber-200/80">Could not load workspace bots.</p>
            </div>
          ) : bots.length === 0 ? (
            isBotManager ? (
              <NavLink
                to="/chatbot"
                onClick={handleNavClick}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border border-dashed border-surface-300 dark:border-surface-700 bg-surface-50 dark:bg-surface-900/50 hover:bg-surface-100 dark:hover:bg-surface-800 transition-all text-left"
              >
                <div className="w-6 h-6 rounded-md bg-primary-500/10 flex items-center justify-center flex-shrink-0">
                  <Plus size={13} className="text-primary-400" />
                </div>
                <p className="text-[12px] font-semibold text-primary-400 truncate">Create a Chatbot</p>
              </NavLink>
            ) : (
              <div className="w-full rounded-lg border border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900/50 px-3 py-2">
                <p className="text-[11px] font-semibold text-surface-700 dark:text-surface-200">No workspace bots</p>
                <p className="mt-1 text-[10px] text-surface-500 dark:text-surface-400">An owner or admin needs to add one.</p>
              </div>
            )
          ) : (
            <div className="relative">
              <button
                onClick={() => setDropdownOpen(!dropdownOpen)}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-surface-50 dark:bg-surface-900/80 border border-surface-200 dark:border-surface-800 hover:border-surface-300 dark:hover:border-surface-700 transition-all text-left group"
              >
                <div className="w-6 h-6 rounded-md bg-primary-500/15 flex items-center justify-center flex-shrink-0">
                  <Bot size={13} className="text-primary-400" />
                </div>
                <p className="text-[12px] font-semibold text-surface-700 dark:text-surface-200 truncate flex-1">
                  {selectedBot?.name || 'Select a Bot'}
                </p>
                <ChevronDown size={14} className={cn('text-surface-500 transition-transform', dropdownOpen && 'rotate-180')} />
              </button>

              <AnimatePresence>
                {dropdownOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -4, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.98 }}
                    transition={{ duration: 0.15 }}
                    className="absolute left-0 right-0 mt-1 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-800 rounded-xl shadow-xl overflow-hidden z-50"
                  >
                    <div className="max-h-48 overflow-y-auto py-1">
                      {bots.map((bot) => (
                        <button
                          key={bot.id}
                          onClick={() => { selectBot(bot); setDropdownOpen(false); }}
                          className={cn(
                            'w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors',
                            selectedBot?.id === bot.id && 'bg-surface-100 dark:bg-surface-800/50'
                          )}
                        >
                          <div className="w-5 h-5 rounded-md bg-surface-100 dark:bg-surface-800 flex items-center justify-center flex-shrink-0">
                            <Bot size={11} className="text-surface-500 dark:text-surface-400" />
                          </div>
                          <span className="text-[12px] font-medium text-surface-700 dark:text-surface-300 truncate flex-1">{bot.name}</span>
                          {selectedBot?.id === bot.id && <Check size={13} className="text-primary-400 flex-shrink-0" />}
                        </button>
                      ))}
                    </div>
                    {isBotManager && (
                      <div className="border-t border-surface-200 dark:border-surface-800">
                        <button
                          onClick={handleCreateBot}
                          className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-primary-500 dark:text-primary-400 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                        >
                          <Plus size={13} />
                          Create new bot
                        </button>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      )}

      {/* Collapsed bot indicator */}
      {!isOpen && !isMobile && (
        <div className="flex justify-center pb-2">
          {loading ? (
            <div className="w-9 h-9 rounded-lg bg-surface-100 dark:bg-surface-800 animate-pulse" />
          ) : selectedBot ? (
            <div className="w-9 h-9 rounded-lg bg-primary-500/10 flex items-center justify-center" title={selectedBot.name}>
              <Bot size={15} className="text-primary-400" />
            </div>
          ) : isBotManager ? (
            <NavLink to="/chatbot" className="w-9 h-9 rounded-lg bg-white dark:bg-surface-900 border border-dashed border-surface-300 dark:border-surface-700 flex items-center justify-center" title="Create a chatbot">
              <Plus size={15} className="text-surface-500" />
            </NavLink>
          ) : (
            <div className="w-9 h-9 rounded-lg bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-800 flex items-center justify-center" title="No workspace bots">
              <Bot size={15} className="text-surface-600" />
            </div>
          )}
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 space-y-0.5 mt-2">
        {isOpen && <p className="px-3 pt-2 pb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-surface-400 dark:text-surface-600">Main</p>}
        {mainItems.map((item, i) => renderLink(item, i))}

        <div className="pt-4">
          {isOpen && <p className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-surface-400 dark:text-surface-600">Configure</p>}
          {!isOpen && !isMobile && <div className="border-t border-surface-200 dark:border-surface-800 mb-2 mx-2" />}
          {configItems.map((item, i) => renderLink(item, i))}
        </div>
      </nav>

      {/* Bottom: Settings link only — the user identity card lives in TopBar's
          profile dropdown, so showing the avatar + name here is duplicate. */}
      <div className="shrink-0 p-3 border-t border-surface-200 dark:border-surface-800/50">
        <NavLink
          to="/settings"
          onClick={handleNavClick}
          className={cn(
            'flex items-center gap-3 px-3 py-2 rounded-xl transition-all group',
            isOpen ? 'w-full' : 'w-10 h-10 justify-center',
            location.pathname.startsWith('/settings')
              ? 'bg-primary-50 dark:bg-white/[0.08] text-primary-700 dark:text-white'
              : 'text-surface-500 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-white/[0.05] hover:text-surface-700 dark:hover:text-surface-200'
          )}
          title={!isOpen ? 'Settings' : undefined}
          aria-label="Settings"
        >
          <Settings size={18} className="shrink-0" />
          {isOpen && (
            <span className="text-[13px] font-medium truncate">Settings</span>
          )}
        </NavLink>
      </div>
    </aside>
  );
}
