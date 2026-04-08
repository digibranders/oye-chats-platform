import { useEffect, useCallback, useRef, useId, createContext, useContext } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

const DrawerContext = createContext(null);

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export default function Drawer({ open, onClose, children, className, side = 'right', size = 'md' }) {
  const drawerRef = useRef(null);
  const titleId = useId();

  const handleEsc = useCallback((e) => {
    if (e.key === 'Escape') onClose?.();
  }, [onClose]);

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleEsc);
      document.body.style.overflow = 'hidden';

      const timer = setTimeout(() => {
        const focusable = drawerRef.current?.querySelector(FOCUSABLE_SELECTOR);
        focusable?.focus();
      }, 50);

      return () => {
        clearTimeout(timer);
        document.removeEventListener('keydown', handleEsc);
        document.body.style.overflow = '';
      };
    }
  }, [open, handleEsc]);

  // Focus trap: Tab wraps within the drawer
  useEffect(() => {
    if (!open) return;

    const handleFocusTrap = (e) => {
      if (e.key !== 'Tab' || !drawerRef.current) return;

      const focusableElements = Array.from(
        drawerRef.current.querySelectorAll(FOCUSABLE_SELECTOR)
      );
      if (focusableElements.length === 0) return;

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleFocusTrap);
    return () => document.removeEventListener('keydown', handleFocusTrap);
  }, [open]);

  const sizes = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-xl', '2xl': 'max-w-2xl' };
  const isRight = side === 'right';

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-black/40 dark:bg-black/60"
            onClick={onClose}
          />
          <motion.div
            ref={drawerRef}
            initial={{ x: isRight ? '100%' : '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: isRight ? '100%' : '-100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className={cn(
              'relative h-full w-full bg-white dark:bg-surface-900 shadow-2xl border-surface-200 dark:border-surface-800 overflow-y-auto',
              isRight ? 'ml-auto border-l' : 'mr-auto border-r',
              sizes[size],
              className
            )}
          >
            <DrawerContext.Provider value={{ titleId }}>
              {children}
            </DrawerContext.Provider>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

function DrawerHeader({ children, onClose, className }) {
  return (
    <div className={cn('sticky top-0 z-10 bg-white dark:bg-surface-900 border-b border-surface-200 dark:border-surface-800 px-6 py-4 flex items-center justify-between', className)}>
      <div className="flex-1 min-w-0">{children}</div>
      {onClose && (
        <button
          onClick={onClose}
          aria-label="Close"
          className="p-1.5 rounded-lg text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}

function DrawerTitle({ children, className }) {
  const ctx = useContext(DrawerContext);
  return (
    <h2 id={ctx?.titleId} className={cn('text-lg font-semibold text-surface-900 dark:text-surface-50 tracking-tight', className)}>
      {children}
    </h2>
  );
}

function DrawerBody({ children, className }) {
  return <div className={cn('p-6', className)}>{children}</div>;
}

export { DrawerHeader, DrawerTitle, DrawerBody };
