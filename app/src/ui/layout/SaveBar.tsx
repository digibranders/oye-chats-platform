import { useCallback, useEffect, type ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from '../primitives/Button';
import { CardFooter } from './Card';
import { ConfirmDialog } from '../overlays/ConfirmDialog';
import { useTranslation } from '../../i18n/useTranslation';
import { t as translateNow } from '../../i18n/i18n';

/**
 * The half of the contract that needs a data router.
 *
 * Separated so `useBlocker` is only ever called when a caller asked to be
 * guarded. Calling it unconditionally would make every form on this bar require
 * `createMemoryRouter` in its tests and a data router in the app — a real cost
 * imposed on the surfaces that opted out.
 */
function NavigationGuard({ dirty, surface }: { dirty: boolean; surface: string }) {
  const { t } = useTranslation();
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
      title={t('ds.leaveWithoutSaving') || 'Leave without saving?'}
      description={
        translateNow('ds.changesToSurfaceNotSaved', { surface }) ||
        `Your changes to ${surface} have not been saved. Leaving now discards them.`
      }
      confirmLabel={translateNow('ds.discardAndLeave') || 'Discard and leave'}
      cancelLabel={translateNow('ds.keepEditing') || 'Keep editing'}
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
  saveLabel: saveLabelProp,
  discardLabel: discardLabelProp,
  variant = 'sticky',
  guard = null,
  className,
}: SaveBarProps) {
  const { t } = useTranslation();
  const canSave = dirty && !saving && blockedReason === null;

  // Cmd/Ctrl+S saves. A settings form is the one place a user types and then
  // walks away expecting it kept, and on a long page the bar is off screen at
  // the moment they finish. The shortcut is bound only while a save is actually
  // possible, so a clean page keeps the browser's own behaviour.
  //
  // No "not while typing" guard, and that is the difference from the shell's
  // Cmd+K. That palette must yield to a composer or a search field, where the
  // user expects their browser's shortcut. Cmd+S has no such meaning inside a
  // web form (the browser's is "save this page as HTML"), and the cursor being
  // in a field is exactly when someone reaches for it.
  useEffect(() => {
    if (!canSave) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey)) return;
      if (event.altKey || event.shiftKey) return;
      event.preventDefault();
      onSave();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canSave, onSave]);
  // `??` would also swallow an explicit `null`; a default parameter
  // only applies to `undefined`, and callers pass null to opt OUT.
  const saveLabel = saveLabelProp === undefined ? (t('ds.saveChanges') || 'Save changes') : saveLabelProp;
  // `??` would also swallow an explicit `null`; a default parameter
  // only applies to `undefined`, and callers pass null to opt OUT.
  const discardLabel = discardLabelProp === undefined ? (t('ds.discard') || 'Discard') : discardLabelProp;
  // A failed save leaves the draft dirty, so this is where the reason belongs —
  // beside the button that produced it, not in a toast that has already gone.
  const message = saveError
    ? saveError
    : blockedReason
      ? blockedReason
      : !dirty
        ? t('ds.everythingHereIsSaved') || 'Everything here is saved.'
        : summary
          ? // Deliberately just the fact. An earlier draft appended "nothing is
            // live until you save", which is true of a chatbot's greeting and
            // false of a personal notification preference — a shared primitive
            // cannot make that claim on every caller's behalf.
            translateNow('ds.unsavedChangesTo', { summary }) || `Unsaved changes to ${summary}.`
          : t('ds.youHaveUnsavedChanges') || 'You have unsaved changes.';
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
        {/* `primary`, stated. Without a variant this took Button's default,
            `secondary`, so Save was an outlined button beside a ghost Discard:
            two quiet controls on a bar whose whole job is "there is one thing
            to do here". The filled ink button is the house primary, and this
            is the textbook case for it. The bar's own surface stays sunken on
            purpose; the button is the beacon, not the tray. */}
        <Button
          variant="primary"
          size="sm"
          onClick={onSave}
          loading={saving}
          disabled={!canSave}
          aria-keyshortcuts="Meta+S Control+S"
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
        <div
          className={cn('sticky bottom-gutter z-[var(--z-sticky)] lg:bottom-gutter-lg', className)}
        >
          {/* One geometry for both forms. They used to share none: 20 vs 16
              horizontal, sunken vs white, hairline vs control-weight border —
              two versions of one control, and a user who saves in a footer on
              one page and a floating bar on the next met both. Floating is
              expressed by the shadow and nothing else. */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-sunken px-cell py-3 shadow-md">
            {controls}
          </div>
        </div>
      ) : saved ? (
        <p
          role="status"
          aria-live="polite"
          className={cn('flex items-center gap-2 text-prose font-medium text-success', className)}
        >
          <CheckCircle2 aria-hidden className="h-icon-md w-icon-md" />
          {t('ds.allChangesSaved') || 'All changes saved.'}
        </p>
      ) : null}

      {guard ? <NavigationGuard dirty={dirty} surface={guard} /> : null}
    </>
  );
}
