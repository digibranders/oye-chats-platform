import { useId, useRef, useState, type ReactNode } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { cn } from '../lib/cn';
import { Button } from '../primitives/Button';
import { Input } from '../primitives/Input';
import { Field } from '../primitives/Field';
import { Alert } from '../feedback/Alert';
import {
  OVERLAY_BODY,
  OVERLAY_DESCRIPTION,
  OVERLAY_FOOTER,
  OVERLAY_SCRIM,
  OVERLAY_TITLE,
} from './overlayParts';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** State the consequence in full. "This cannot be undone" alone is not one. */
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  /** Red confirm button. Off by default — a benign confirmation is not a warning. */
  destructive?: boolean;
  /**
   * Demand the user type this exact string before confirming.
   *
   * Reserve it for actions that destroy work which cannot be recreated —
   * deleting a chatbot and its whole knowledge base, closing an account. Asking
   * for it on a routine delete trains people to type past it, which is worse
   * than not asking at all.
   */
  confirmPhrase?: string;
  confirmPhraseLabel?: string;
}

/**
 * A blocking confirmation.
 *
 * An `AlertDialog`, not a plain dialog: it carries `role="alertdialog"` and it
 * cannot be dismissed by clicking outside. Those are exactly the differences
 * that matter when the next keypress deletes something.
 *
 * One component, rather than the previous app's mixture of inline two-button
 * swaps, per-page bespoke modals, and a `ConfirmProvider` that was written and
 * never mounted — which is how seven equally destructive actions ended up with
 * no confirmation at all, including promoting a member to Owner and deleting a
 * saved payment method.
 *
 * Three things it got wrong and no longer does.
 *
 * The confirm button is a `Button`, so it keeps its label while it works.
 * A raw `<button>` here swapped "Delete chatbot" for "Working…" — reflowing the
 * footer, losing the spinner entirely, and doing it in the one dialog where the
 * user most needs to know what they just pressed. `Button` documents that
 * contract; this was the only place in the system breaking it.
 *
 * It scrolls. A fully-stated consequence plus a confirm-phrase field plus a
 * failed-action `Alert` overflowed a 700px laptop viewport with the confirm
 * button off screen — and because the popup is centred by a transform, there was
 * no way to scroll to it.
 *
 * A blocked confirm says why. `SaveBar`'s contract already requires "a specific
 * reason when saving is blocked"; here the user mistyped the name by one
 * character and the button was simply dead.
 *
 * Cancel is `secondary`, not `ghost`. Two equal-weight outlined buttons where
 * colour is the only difference is precisely the "this is a decision" reading
 * DESIGN.md §6.6 asks for — where before, the destructive button was the only
 * thing on the footer with any chrome at all, so the eye went straight to it.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  destructive = false,
  confirmPhrase,
  confirmPhraseLabel,
}: ConfirmDialogProps) {
  // Focus lands on Cancel, not on the destructive button and not on the popup
  // itself. When the next keypress can delete something, the default answer has
  // to be the safe one.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();

  const phraseSatisfied = !confirmPhrase || typed.trim() === confirmPhrase;

  async function handleConfirm() {
    if (!phraseSatisfied) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      // The caller decides what "done" means and closes the dialog itself, so a
      // failure it handles inline can keep the dialog open with the typed
      // phrase intact.
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function handleOpenChange(next: boolean) {
    // Never close while the action is in flight: the user cannot tell a
    // cancelled request from a completed one.
    if (busy) return;
    if (!next) {
      setTyped('');
      setError(null);
    }
    onOpenChange(next);
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={handleOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={OVERLAY_SCRIM} />
        <AlertDialog.Popup
          initialFocus={cancelRef}
          className={cn(
            'motion-panel fixed left-1/2 top-1/2 z-[var(--z-overlay)] flex max-h-[calc(100dvh-2rem)]',
            'w-[calc(100dvw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col',
            'overflow-hidden rounded-xl border border-border bg-surface shadow-lg focus:outline-none',
          )}
        >
          <div className={OVERLAY_BODY}>
            <AlertDialog.Title className={OVERLAY_TITLE}>{title}</AlertDialog.Title>
            <AlertDialog.Description className={OVERLAY_DESCRIPTION}>
              {description}
            </AlertDialog.Description>

            {confirmPhrase ? (
              <Field
                className="mt-4"
                label={confirmPhraseLabel ?? `Type ${confirmPhrase} to confirm`}
              >
                <Input
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                  // Not autofocused: focus landing in a text field means the
                  // first Enter submits a destructive action the user has not
                  // finished reading.
                  placeholder={confirmPhrase}
                />
              </Field>
            ) : null}

            {/* An action failure is not a field error. Rendering it under the
                confirm-phrase input said the phrase was wrong when the server
                had refused for an entirely different reason. */}
            {error ? (
              <Alert tone="danger" live className="mt-4">
                {error}
              </Alert>
            ) : null}
          </div>

          <div className={OVERLAY_FOOTER}>
            {!phraseSatisfied && confirmPhrase ? (
              <span id={reasonId} className="mr-auto text-xs text-text-secondary">
                Type the name exactly to continue.
              </span>
            ) : null}
            <AlertDialog.Close
              ref={cancelRef}
              render={
                <Button variant="secondary" disabled={busy}>
                  {cancelLabel}
                </Button>
              }
            />
            {/* A plain `Button`, not `AlertDialog.Close`: closing on click would
                tear down the busy state and the error surface before the request
                settles. */}
            <Button
              variant={destructive ? 'danger' : 'primary'}
              loading={busy}
              disabled={!phraseSatisfied}
              aria-describedby={!phraseSatisfied && confirmPhrase ? reasonId : undefined}
              onClick={handleConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
