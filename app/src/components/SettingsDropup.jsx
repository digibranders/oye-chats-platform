import { useState, useRef, useEffect } from 'react';
import { Settings, MessageCircle } from 'lucide-react';
import FeedbackModal from './FeedbackModal';
import { cn } from '../lib/utils';
import { submitPlatformFeedback } from '../services/api';

const SettingsDropup = ({ isOpen: sidebarOpen }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isFeedbackModalOpen, setIsFeedbackModalOpen] = useState(false);
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

  const handleFeedbackSubmit = async (payload) => {
    await submitPlatformFeedback(payload);
  };

  return (
    <>
      <div className="relative w-full" ref={dropupRef}>
        {isOpen && (
          <div className="absolute bottom-full left-0 mb-2 w-full bg-white dark:bg-surface-900 text-surface-900 dark:text-white rounded-xl shadow-2xl border border-surface-200 dark:border-surface-800 z-50">
            <div className="p-1.5 space-y-0.5">
              <button
                onClick={() => {
                  setIsFeedbackModalOpen(true);
                  setIsOpen(false);
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors text-left text-sm font-medium text-surface-700 dark:text-surface-300"
              >
                <div className="p-1.5 rounded-md bg-surface-100 dark:bg-surface-800">
                  <MessageCircle size={16} className="text-surface-500 dark:text-surface-400" />
                </div>
                <span className="flex-1">Send feedback</span>
              </button>
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
          title={!sidebarOpen ? "Settings" : undefined}
        >
          <Settings
            size={18}
            className={cn(
              'flex-shrink-0 transition-colors',
              isOpen
                ? 'text-primary-600 dark:text-primary-400'
                : 'text-surface-400 group-hover:text-surface-600 dark:group-hover:text-surface-300'
            )}
          />
          {sidebarOpen && <span className="truncate text-sm">Settings</span>}
        </button>
      </div>

      <FeedbackModal
        isOpen={isFeedbackModalOpen}
        onClose={() => setIsFeedbackModalOpen(false)}
        onSubmit={handleFeedbackSubmit}
      />
    </>
  );
};

export default SettingsDropup;
