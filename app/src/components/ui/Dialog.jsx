import { useEffect, useCallback, useRef, useId, createContext, useContext } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

const DialogContext = createContext(null);

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export default function Dialog({ open, onClose, children, className, size = 'md' }) {
  const dialogRef = useRef(null);
  const titleId = useId();

  const handleEsc = useCallback((e) => {
    if (e.key === 'Escape') onClose?.();
  }, [onClose]);

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleEsc);
      document.body.style.overflow = 'hidden';

      const timer = setTimeout(() => {
        const focusable = dialogRef.current?.querySelector(FOCUSABLE_SELECTOR);
        focusable?.focus();
      }, 50);

      return () => {
        clearTimeout(timer);
        document.removeEventListener('keydown', handleEsc);
        document.body.style.overflow = '';
      };
    }
  }, [open, handleEsc]);

  // Focus trap: Tab wraps within the dialog
  useEffect(() => {
    if (!open) return;

    const handleFocusTrap = (e) => {
      if (e.key !== 'Tab' || !dialogRef.current) return;

      const focusableElements = Array.from(
        dialogRef.current.querySelectorAll(FOCUSABLE_SELECTOR)
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

  const sizes = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl',
    full: 'max-w-4xl',
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            ref={dialogRef}
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className={cn(
              'relative w-full bg-white dark:bg-surface-900 rounded-2xl shadow-2xl border border-surface-200 dark:border-surface-800 overflow-hidden',
              sizes[size],
              className
            )}
          >
            <DialogContext.Provider value={{ titleId }}>
              {children}
            </DialogContext.Provider>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

function DialogHeader({ children, onClose, className }) {
  return (
    <div className={cn('px-6 pt-6 pb-2 flex items-start justify-between', className)}>
      <div className="flex-1 min-w-0">{children}</div>
      {onClose && (
        <button
          onClick={onClose}
          aria-label="Close"
          className="p-1.5 rounded-lg text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors flex-shrink-0 ml-4"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}

function DialogTitle({ children, className }) {
  const ctx = useContext(DialogContext);
  return (
    <h2 id={ctx?.titleId} className={cn('text-lg font-semibold text-surface-900 dark:text-surface-50 tracking-tight', className)}>
      {children}
    </h2>
  );
}

function DialogDescription({ children, className }) {
  return (
    <p className={cn('text-sm text-surface-500 dark:text-surface-400 mt-1', className)}>
      {children}
    </p>
  );
}

function DialogBody({ children, className }) {
  return <div className={cn('px-6 py-4', className)}>{children}</div>;
}

function DialogFooter({ children, className }) {
  return (
    <div className={cn('px-6 pb-6 pt-2 flex items-center justify-end gap-3', className)}>
      {children}
    </div>
  );
}

export { DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter };
