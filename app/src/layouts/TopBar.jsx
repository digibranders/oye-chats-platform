import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, LogOut, Menu, PanelLeftClose, Settings, Mail, Bot as BotIcon, Calendar } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import Breadcrumbs from '../components/Breadcrumbs';
import { AUTH_STORAGE_KEYS } from '../utils/auth';
import Avatar from '../components/ui/Avatar';
import { getCurrentUser } from '../services/api';

// Format an ISO timestamp as e.g. "Joined May 4, 2026". Returns "—" on bad input
// so a fetch hiccup or pre-2024 row never renders the profile dropdown blank.
function _formatJoinedDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '—';
  }
}

export default function TopBar({ isSidebarOpen, isMobile, toggleSidebar, onOpenSearch }) {
  const navigate = useNavigate();
  const adminName = localStorage.getItem('admin_name') || 'Admin';
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [profile, setProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState(false);
  // Mounted-flag prevents a state update after the menu closes if the network
  // request is still in flight — avoids the React "set state on unmounted" warn.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const handleLogout = () => {
    AUTH_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
    navigate('/login');
  };

  // Fetch profile lazily the first time the menu opens (and refresh on every
  // open after that so bot_count stays current). The dropdown renders
  // immediately with cached values; a spinner never appears for return opens.
  useEffect(() => {
    if (!showUserMenu) return;
    let cancelled = false;
    const fetchProfile = async () => {
      setProfileLoading(true);
      setProfileError(false);
      try {
        const data = await getCurrentUser();
        if (!cancelled && mountedRef.current) setProfile(data);
      } catch (err) {
        if (!cancelled && mountedRef.current) {
          setProfileError(true);
          console.error('TopBar: failed to load profile', err);
        }
      } finally {
        if (!cancelled && mountedRef.current) setProfileLoading(false);
      }
    };
    fetchProfile();
    return () => { cancelled = true; };
  }, [showUserMenu]);

  return (
    <header className="h-14 bg-white/80 dark:bg-surface-950/80 backdrop-blur-xl border-b border-surface-200/60 dark:border-surface-800/60 px-3 md:px-6 flex items-center justify-between sticky top-0 z-20 transition-colors">
      {/* Left */}
      <div className="flex items-center gap-2 md:gap-3 min-w-0">
        <button
          onClick={toggleSidebar}
          className="p-1.5 rounded-lg text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors shrink-0"
          title={isSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          {isSidebarOpen && !isMobile ? <PanelLeftClose size={18} /> : <Menu size={18} />}
        </button>
        <div className="min-w-0 truncate">
          <Breadcrumbs />
        </div>
      </div>

      {/* Center: Search */}
      <button
        onClick={onOpenSearch}
        className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-surface-100 dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-xl text-surface-400 hover:border-surface-300 dark:hover:border-surface-600 transition-colors text-sm cursor-pointer"
      >
        <Search size={14} />
        <span className="text-[13px]">Search...</span>
        <kbd className="ml-4 px-1.5 py-0.5 bg-surface-200 dark:bg-surface-700 rounded text-[10px] font-semibold text-surface-500 dark:text-surface-400">
          ⌘K
        </kbd>
      </button>

      {/* Right */}
      <div className="flex items-center gap-1 md:gap-2">
        {/* Mobile search */}
        <button
          onClick={onOpenSearch}
          className="md:hidden p-2 rounded-lg text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
        >
          <Search size={16} />
        </button>

        {/* User menu */}
        <div className="relative">
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            onBlur={() => setTimeout(() => setShowUserMenu(false), 150)}
            className="flex items-center gap-2 p-1 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
          >
            <Avatar name={adminName} size="sm" />
            <span className="hidden md:block text-[13px] font-medium text-surface-700 dark:text-surface-300 max-w-[100px] truncate">
              {adminName}
            </span>
          </button>

          <AnimatePresence>
            {showUserMenu && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 4 }}
                transition={{ duration: 0.12 }}
                className="absolute right-0 mt-1 w-72 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-800 rounded-xl shadow-xl z-50 overflow-hidden"
              >
                {/* Identity header */}
                <div className="px-4 py-4 border-b border-surface-100 dark:border-surface-800 flex items-start gap-3">
                  <Avatar name={profile?.name || adminName} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="text-[14px] font-semibold text-surface-900 dark:text-surface-50 truncate">
                        {profile?.name || adminName}
                      </p>
                      {/* Show the operator role as a small chip when applicable
                          — clients have role=null so this is a no-op for admins. */}
                      {profile?.kind === 'operator' && profile?.role && (
                        <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary-100 dark:bg-primary-500/20 text-primary-700 dark:text-primary-300 shrink-0">
                          {profile.role}
                        </span>
                      )}
                    </div>
                    <p className="text-[12px] text-surface-500 dark:text-surface-400 truncate">
                      {profileLoading && !profile ? 'Loading…' : (profile?.email || (profileError ? 'Profile unavailable' : '—'))}
                    </p>
                  </div>
                </div>

                {/* Profile facts */}
                <div className="px-4 py-3 border-b border-surface-100 dark:border-surface-800 space-y-2">
                  <div className="flex items-center gap-2 text-[12px] text-surface-600 dark:text-surface-300">
                    <Mail className="w-3.5 h-3.5 text-surface-400 shrink-0" />
                    <span className="truncate">{profile?.email || '—'}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[12px] text-surface-600 dark:text-surface-300">
                    <BotIcon className="w-3.5 h-3.5 text-surface-400 shrink-0" />
                    <span>
                      {profile?.bot_count ?? '—'} {profile?.bot_count === 1 ? 'bot' : 'bots'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[12px] text-surface-600 dark:text-surface-300">
                    <Calendar className="w-3.5 h-3.5 text-surface-400 shrink-0" />
                    <span>Joined {_formatJoinedDate(profile?.created_at)}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="p-1">
                  <button
                    onClick={() => { setShowUserMenu(false); navigate('/settings'); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-800 rounded-lg transition-colors"
                  >
                    <Settings size={14} />
                    Settings
                  </button>
                  <div className="border-t border-surface-100 dark:border-surface-800 mt-1 pt-1">
                    <button
                      onClick={handleLogout}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg transition-colors font-medium"
                    >
                      <LogOut size={14} />
                      Sign out
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </header>
  );
}
