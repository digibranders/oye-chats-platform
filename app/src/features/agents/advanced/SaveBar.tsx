import { useCallback, useEffect } from 'react';
import { useBlocker } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { Button, ConfirmDialog, cn } from '../../../ui';

export interface SaveBarProps {
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  /** A failed PATCH, in the user's terms. */
  saveError: string | null;
  /**
   * Why this draft cannot be saved yet, named specifically.
   *
   * Never "please fix the errors above": the reader has to be able to act on it
   * without hunting. When set, Save is disabled and this replaces the count.
   */
  blockedReason: string | null;
  onSave: () => void;
  onDiscard: () => void;
  /** Names the surface in the leave prompt, e.g. "lead qualification". */
  surface: string;
  className?: string;
}

/**
 * The unsaved-changes contract, in one place for both pages.
 *
 * Three things have to be true at once, and the page this replaces only managed
 * the first: the user must be able to *see* that work is pending, to *undo* it,
 * and to be *stopped* from walking away from it. In-app navigation is caught by
 * the router's blocker, a tab close by `beforeunload`, and a chatbot switch by
 * the blocker too — the route path changes in every one of those cases.
 *
 * The bar is sticky rather than fixed so it belongs to the page's scroll body
 * and cannot end up floating over another surface's content, and it is rendered
 * only while there is something to save. When there is not, the same slot
 * carries the saved confirmation, which is a live region so a screen-reader user
 * hears the outcome of a save they cannot see land.
 */
export function SaveBar({
  dirty,
  saving,
  saved,
  saveError,
  blockedReason,
  onSave,
  onDiscard,
  surface,
  className,
}: SaveBarProps) {
  // Warn before a full-page unload while there is pending work.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }) =>
        dirty && currentLocation.pathname !== nextLocation.pathname,
      [dirty],
    ),
  );

  const blocked = blocker.state === 'blocked';

  return (
    <>
      {dirty ? (
        <div className={cn('sticky bottom-4 z-[var(--z-sticky)]', className)}>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-strong bg-surface px-4 py-3 shadow-md">
            {/* A failed save leaves the draft dirty, so this bar is where the
                reason belongs — beside the button that produced it, not in a
                toast that has already gone. `role="status"` so it is announced
                when it replaces the count. */}
            <div className="min-w-0 flex-1" role="status" aria-live="polite">
              {saveError ? (
                <p className="text-prose text-danger">{saveError}</p>
              ) : blockedReason ? (
                <p className="text-prose text-danger">{blockedReason}</p>
              ) : (
                <p className="text-prose text-text-secondary">
                  You have unsaved changes. Nothing is live until you save.
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
                Discard changes
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={onSave}
                loading={saving}
                disabled={saving || blockedReason !== null}
              >
                Save changes
              </Button>
            </div>
          </div>
        </div>
      ) : saved ? (
        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-prose font-medium text-success"
        >
          <CheckCircle2 aria-hidden className="h-4 w-4" />
          All changes saved.
        </p>
      ) : null}

      <ConfirmDialog
        open={blocked}
        onOpenChange={(next) => {
          if (!next) blocker.reset?.();
        }}
        title="Leave without saving?"
        description={`Your changes to this chatbot's ${surface} have not been saved. Leaving now discards them.`}
        confirmLabel="Discard and leave"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => blocker.proceed?.()}
      />
    </>
  );
}
