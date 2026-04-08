import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, LogOut, Menu, PanelLeftClose, Sun, Moon, Monitor, Settings } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import Breadcrumbs from '../components/Breadcrumbs';
import { AUTH_STORAGE_KEYS } from '../utils/auth';
import { useTheme } from '../context/ThemeContext';
import Avatar from '../components/ui/Avatar';
import { cn } from '../lib/utils';

export default function TopBar({ isSidebarOpen, isMobile, toggleSidebar, onOpenSearch }) {
  const navigate = useNavigate();
  const adminName = localStorage.getItem('admin_name') || 'Admin';
  const [showUserMenu, setShowUserMenu] = useState(false);
  const { mode, setTheme } = useTheme();

  const handleLogout = () => {
    AUTH_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
    navigate('/login');
  };

  const themeOptions = [
    { value: 'light', icon: Sun, label: 'Light' },
    { value: 'dark', icon: Moon, label: 'Dark' },
    { value: 'system', icon: Monitor, label: 'System' },
  ];

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

        {/* Theme toggle (desktop only) */}
        <div className="hidden md:flex items-center gap-0.5 p-0.5 bg-surface-100 dark:bg-surface-800 rounded-lg">
          {themeOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setTheme(opt.value)}
              className={cn(
                'p-1.5 rounded-md transition-all',
                mode === opt.value
                  ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-surface-100 shadow-sm'
                  : 'text-surface-400 hover:text-surface-600 dark:hover:text-surface-300'
              )}
              title={opt.label}
            >
              <opt.icon size={13} />
            </button>
          ))}
        </div>

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
                className="absolute right-0 mt-1 w-52 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-800 rounded-xl shadow-xl z-50 overflow-hidden"
              >
                <div className="px-4 py-3 border-b border-surface-100 dark:border-surface-800">
                  <p className="text-sm font-medium text-surface-900 dark:text-surface-50">{adminName}</p>
                  <p className="text-xs text-surface-400 dark:text-surface-500 mt-0.5">Manage account</p>
                </div>
                <div className="p-1">
                  <button
                    onClick={() => { setShowUserMenu(false); navigate('/settings'); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-800 rounded-lg transition-colors"
                  >
                    <Settings size={14} />
                    Settings
                  </button>

                  {/* Mobile theme switcher */}
                  <div className="md:hidden px-3 py-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-surface-400 mb-2">Theme</p>
                    <div className="flex gap-1">
                      {themeOptions.map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => setTheme(opt.value)}
                          className={cn(
                            'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-all',
                            mode === opt.value
                              ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-600 dark:text-primary-400'
                              : 'text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-800'
                          )}
                        >
                          <opt.icon size={12} />
                        </button>
                      ))}
                    </div>
                  </div>

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
