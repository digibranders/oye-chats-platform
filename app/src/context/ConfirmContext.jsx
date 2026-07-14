/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import Dialog, {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/Dialog';
import { Button } from '../components/ui/Button';

/**
 * ConfirmContext — a promise-based replacement for the native `window.confirm`.
 *
 * Native `confirm()`/`alert()` render unstyled browser chrome that ignores the
 * app's design language, can't be themed, isn't translatable, and blocks the
 * JS event loop. This provider renders confirmations through the app's own
 * accessible `Dialog` primitive (focus-trap, ESC-to-cancel, aria-modal) while
 * keeping the ergonomics of `confirm()` at the call site:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: 'Delete webhook?', tone: 'danger' }))) return;
 *   // …proceed with the destructive action
 *
 * The returned promise resolves `true` on confirm and `false` on cancel / ESC /
 * backdrop-click, so existing `if (!confirm(...)) return;` guards convert with
 * a one-line change.
 */

const ConfirmContext = createContext(null);

const DEFAULTS = {
  title: 'Are you sure?',
  description: '',
  confirmLabel: 'Confirm',
  cancelLabel: 'Cancel',
  /** 'default' → primary confirm button · 'danger' → destructive confirm button */
  tone: 'default',
};

export function ConfirmProvider({ children }) {
  // `options` is null while closed, or the merged option object while open.
  const [options, setOptions] = useState(null);
  const resolverRef = useRef(null);

  const confirm = useCallback((opts = {}) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setOptions({ ...DEFAULTS, ...opts });
    });
  }, []);

  const settle = useCallback((result) => {
    // Resolve exactly once; a null resolver means the dialog already settled.
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOptions(null);
    resolve?.(result);
  }, []);

  const handleCancel = useCallback(() => settle(false), [settle]);
  const handleConfirm = useCallback(() => settle(true), [settle]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={options !== null} onClose={handleCancel} size="sm">
        {options && (
          <>
            <DialogHeader>
              <DialogTitle>{options.title}</DialogTitle>
              {options.description ? (
                <DialogDescription>{options.description}</DialogDescription>
              ) : null}
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={handleCancel}>
                {options.cancelLabel}
              </Button>
              <Button
                variant={options.tone === 'danger' ? 'destructive' : 'primary'}
                onClick={handleConfirm}
              >
                {options.confirmLabel}
              </Button>
            </DialogFooter>
          </>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    throw new Error('useConfirm must be used within a ConfirmProvider');
  }
  return confirm;
}
