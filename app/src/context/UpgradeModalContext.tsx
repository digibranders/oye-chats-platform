/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useState, type ReactElement, type ReactNode } from 'react';
import { UpgradeModal, type UpgradeModalReason } from '../design-system/components/UpgradeModal';

export type { UpgradeModalReason };

/**
 * UpgradeModalContext — the global trigger for the premium upsell dialog.
 *
 * Ported from the legacy `context/UpgradeModalContext.jsx` intent registry
 * into a simpler, caller-supplied-copy API: rather than a fixed registry of
 * intent keys, callers (FeatureGate, limit-gated actions) pass a
 * `UpgradeModalReason` directly. The provider keeps a single piece of state
 * (`reason`) — non-null means the modal is open. Only one upsell is shown at
 * a time; the most recent request wins, matching the legacy behavior so a
 * user who trips two gates in the same flow doesn't see a modal stack.
 */
export interface UpgradeModalContextValue {
  /** Open the upgrade modal. Omit `reason` (or pass `{}`) for a generic prompt. */
  openUpgradeModal: (reason?: UpgradeModalReason) => void;
  close: () => void;
  isOpen: boolean;
}

const UpgradeModalContext = createContext<UpgradeModalContextValue | null>(null);

export function UpgradeModalProvider({ children }: { children: ReactNode }): ReactElement {
  const [reason, setReason] = useState<UpgradeModalReason | null>(null);

  const close = useCallback((): void => setReason(null), []);

  const openUpgradeModal = useCallback((next?: UpgradeModalReason): void => {
    setReason(next ?? {});
  }, []);

  return (
    <UpgradeModalContext.Provider value={{ openUpgradeModal, close, isOpen: reason !== null }}>
      {children}
      <UpgradeModal open={reason !== null} reason={reason} onClose={close} />
    </UpgradeModalContext.Provider>
  );
}

export function useUpgradeModal(): UpgradeModalContextValue {
  const ctx = useContext(UpgradeModalContext);
  if (!ctx) {
    throw new Error('useUpgradeModal must be used inside <UpgradeModalProvider>');
  }
  return ctx;
}
