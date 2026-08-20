import { useCallback, useEffect, type ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from '../primitives/Button';
import { CardFooter } from './Card';
import { ConfirmDialog } from '../overlays/ConfirmDialog';

/**
 * The half of the contract that needs a data router.
 *
 * Separated so `useBlocker` is only ever called when a caller asked to be
 * guarded. Calling it unconditionally would make every form on this bar require
 * `createMemoryRouter` in its tests and a data router in the app — a real cost
 * imposed on the surfaces that opted out.
 */
function NavigationGuard({ dirty, surface }: { dirty: boolean; surface: string }) {
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

  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      onOpenChange={(next) => {
        if (!next) blocker.reset?.();
      }}
      title="Leave without saving?"
      description={`Your changes to ${surface} have not been saved. Leaving now discards them.`}
      confirmLabel="Discard and leave"
      cancelLabel="Keep editing"
      destructive
      onConfirm={() => blocker.proceed?.()}
    />
  );
}

export interface SaveBarProps {
  /** The draft differs from the server's copy. */
  dirty: boolean;
  saving?: boolean;
  /** A save has just landed. Shows the transient confirmation. */
  saved?: boolean;
  /** A failed save, in the user's terms. Replaces the summary. */
  saveError?: string | null;
  /**
   * Why this draft cannot be saved yet, named specifically.
   *
   * Never "please fix the errors above": the reader has to be able to act on it
   * without hunting. When set, Save is disabled and this replaces the summary.
   */
  blockedReason?: string | null;
  /**
   * *What* changed — "Name and Website", "Branding and Messages".
   *
   * The bar phrases it. Naming the fields beats "you have unsaved changes" on
   * any page with more than one section, because a page that says only *that*
   * something is pending makes the reader hunt for *what*.
   */
  summary?: ReactNode;
  onSave: () => void;
  onDiscard: () => void;
  saveLabel?: string;
  discardLabel?: string;
  /**
   * `sticky` floats above the page's scroll body — the right form for a long
   * page whose save control would otherwise scroll out of reach, and it appears
   * only when there is something to save, because it floats and reflows nothing.
   *
   * `footer` anchors it to a card, for a short form that fits on one screen, and
   * is **always** rendered: a footer that appears on the first keystroke pushes
   * the whole card down at the exact moment the user is typing in it, and a
   * reader who has never seen it does not know a save is required at all.
   */
  variant?: 'sticky' | 'footer';
  /**
   * Intercept navigation while the draft is dirty. Names the surface in the
   * prompt: "your changes to this chatbot's branding".
   *
   * Pass `null` to opt out — appropriate only where leaving genuinely costs the
   * user nothing.
   */
  guard?: string | null;
  className?: string;
}

/**
 * Unsaved work, made visible and recoverable.
 *
 * Three things have to be true at once, and a page that manages only the first
 * has not solved it: the user must be able to **see** that work is pending, to
 * **undo** it, and to be **stopped** from walking away from it. In-app
 * navigation is caught by the router's blocker, a tab close by `beforeunload`.
 *
 * **An explicit bar rather than autosave**, and the reason is blast radius, not
 * taste. On the surfaces that use this, a saved field is published — it is what
 * the customer's visitors read, on the customer's own website. Autosave would
 * push a half-typed greeting live for as long as it took to finish the
 * sentence, and "undo" over something the public has already seen is not an
 * undo. Autosave earns its place on private, low-stakes state; this is the
 * opposite of all three.
 *
 * The sticky form is `position: sticky` inside the page's scroll body, never
 * fixed to the viewport, so it cannot cover a field near the bottom of the form
 * or a panel beside it (WCAG 2.2 SC 2.4.11).
 *
 * This lives here because it had been written three times — once per editable
 * surface — with three different contracts, which is the exact failure this
 * directory exists to prevent.
 */
export function SaveBar({
  dirty,
  saving = false,
  saved = false,
  saveError = null,
  blockedReason = null,
  summary,
  onSave,
  onDiscard,
  saveLabel = 'Save changes',
  discardLabel = 'Discard',
  variant = 'sticky',
  guard = null,
  className,
}: SaveBarProps) {
  // A failed save leaves the draft dirty, so this is where the reason belongs —
  // beside the button that produced it, not in a toast that has already gone.
  const message = saveError
    ? saveError
    : blockedReason
      ? blockedReason
      : !dirty
        ? 'Everything here is saved.'
        : summary
          ? // Deliberately just the fact. An earlier draft appended "nothing is
            // live until you save", which is true of a chatbot's greeting and
            // false of a personal notification preference — a shared primitive
            // cannot make that claim on every caller's behalf.
            <>Unsaved changes to {summary}.</>
          : 'You have unsaved changes.';
  const tone = saveError || blockedReason ? 'text-danger' : 'text-text-secondary';

  const controls = (
    <>
      <div className="min-w-0 flex-1" role="status" aria-live="polite">
        <p className={cn('text-prose', tone)}>{message}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onDiscard} disabled={!dirty || saving}>
          {discardLabel}
        </Button>
        <Button
          size="sm"
          onClick={onSave}
          loading={saving}
          disabled={!dirty || saving || blockedReason !== null}
        >
          {saveLabel}
        </Button>
      </div>
    </>
  );

  if (variant === 'footer') {
    return (
      <>
        <CardFooter className={cn('justify-between gap-3', className)}>{controls}</CardFooter>
        {guard ? <NavigationGuard dirty={dirty} surface={guard} /> : null}
      </>
    );
  }

  return (
    <>
      {dirty ? (
        <div className={cn('sticky bottom-4 z-[var(--z-sticky)]', className)}>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-strong bg-surface px-4 py-3 shadow-md">
            {controls}
          </div>
        </div>
      ) : saved ? (
        <p
          role="status"
          aria-live="polite"
          className={cn('flex items-center gap-2 text-prose font-medium text-success', className)}
        >
          <CheckCircle2 aria-hidden className="h-4 w-4" />
          All changes saved.
        </p>
      ) : null}

      {guard ? <NavigationGuard dirty={dirty} surface={guard} /> : null}
    </>
  );
}
