import { useId } from 'react';
import { motion } from 'framer-motion';
import { Lock } from 'lucide-react';
import { cn } from '../../lib/utils';

export default function Tabs({ tabs, activeTab, onChange, variant = 'pills', className }) {
  const instanceId = useId();
  const handleKeyDown = (e, index) => {
    let nextIndex;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      nextIndex = (index + 1) % tabs.length;
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    } else if (e.key === 'Home') {
      e.preventDefault();
      nextIndex = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      nextIndex = tabs.length - 1;
    }
    if (nextIndex !== undefined) {
      onChange(tabs[nextIndex].id);
      // Focus the new tab button
      e.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[nextIndex]?.focus();
    }
  };

  if (variant === 'underline') {
    return (
      <div role="tablist" className={cn('flex items-center gap-6 border-b border-surface-200 dark:border-surface-800', className)}>
        {tabs.map((tab, index) => {
          const isActive = activeTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onChange(tab.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={cn(
                'relative flex items-center gap-2 pb-3 text-sm font-medium transition-colors',
                isActive
                  ? 'text-primary-600 dark:text-primary-400'
                  : 'text-surface-500 hover:text-surface-700 dark:text-surface-400 dark:hover:text-surface-200'
              )}
            >
              {Icon && <Icon size={15} />}
              {tab.label}
              {tab.count !== undefined && (
                <span className={cn(
                  'text-[10px] font-bold px-1.5 py-0.5 rounded-full',
                  isActive
                    ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
                    : 'bg-surface-100 text-surface-500 dark:bg-surface-800 dark:text-surface-400'
                )}>
                  {tab.count}
                </span>
              )}
              {isActive && (
                <motion.div
                  layoutId={`tab-underline-${instanceId}`}
                  className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary-600 dark:bg-primary-400 rounded-full"
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                />
              )}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div role="tablist" className={cn('flex items-center gap-1 p-1 bg-surface-100 dark:bg-surface-800 rounded-xl w-fit', className)}>
      {tabs.map((tab, index) => {
        const isActive = activeTab === tab.id && !tab.locked;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            aria-disabled={tab.locked ? 'true' : undefined}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            title={tab.locked ? 'Available on Starter and above' : undefined}
            className={cn(
              'relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200',
              isActive
                ? 'text-surface-900 dark:text-surface-50'
                : tab.locked
                  ? 'text-surface-400 dark:text-surface-500 hover:text-surface-600 dark:hover:text-surface-300'
                  : 'text-surface-500 hover:text-surface-700 dark:text-surface-400 dark:hover:text-surface-200'
            )}
          >
            {isActive && (
              <motion.div
                layoutId={`tab-pill-${instanceId}`}
                className="absolute inset-0 bg-white dark:bg-surface-700 rounded-lg shadow-sm"
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-2">
              {Icon && <Icon size={15} />}
              {tab.label}
              {tab.locked && (
                <span
                  className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-600 leading-none dark:bg-amber-500/15 dark:text-amber-400"
                  aria-hidden="true"
                >
                  {/* `block` strips the inline-SVG baseline gap so the
                      glyph centers on the geometric midpoint of the
                      badge instead of sitting on the text baseline. */}
                  <Lock size={11} strokeWidth={2.4} className="block" />
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
