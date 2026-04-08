import { useState, useRef, useEffect } from 'react';
import { Blocks } from 'lucide-react';
import { EmailIcon } from './Icons';
import { NavLink } from 'react-router-dom';
import { cn } from '../lib/utils';

const IntegrationMenu = ({ isOpen: sidebarOpen }) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropupRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropupRef.current && !dropupRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const items = [
    { id: 'email', name: 'Email', icon: EmailIcon, path: '/integrations/email' },
  ];

  return (
    <div className="relative w-full" ref={dropupRef}>
      {isOpen && (
        <div className="absolute bottom-full left-0 mb-2 w-full bg-white dark:bg-surface-900 text-surface-900 dark:text-white rounded-xl shadow-2xl border border-surface-200 dark:border-surface-800 z-50">
          <div className="p-1.5 space-y-0.5">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.id}
                  to={item.path}
                  onClick={() => setIsOpen(false)}
                  className={({ isActive }) => cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors text-left text-sm font-medium',
                    isActive ? 'bg-surface-800 text-white' : 'text-surface-400 hover:bg-surface-800 hover:text-white'
                  )}
                >
                  <div className="p-1.5 rounded-md bg-surface-800">
                    <Icon className="w-[18px] h-[18px]" />
                  </div>
                  <span className="flex-1">{item.name}</span>
                </NavLink>
              );
            })}
          </div>
        </div>
      )}

      <button
        onClick={() => setIsOpen(prev => !prev)}
        className={cn(
          'flex items-center gap-3 px-3 rounded-xl transition-all group w-full h-8',
          isOpen
            ? 'bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-400 font-medium'
            : 'text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:hover:bg-surface-800 hover:text-surface-900 dark:hover:text-surface-200'
        )}
        title={!sidebarOpen ? "Integrations" : undefined}
      >
        <Blocks
          size={18}
          className={cn(
            'flex-shrink-0 transition-colors',
            isOpen
              ? 'text-primary-600 dark:text-primary-400'
              : 'text-surface-400 group-hover:text-surface-600 dark:group-hover:text-surface-300'
          )}
        />
        {sidebarOpen && <span className="truncate text-sm">Integrations</span>}
      </button>
    </div>
  );
};

export default IntegrationMenu;
