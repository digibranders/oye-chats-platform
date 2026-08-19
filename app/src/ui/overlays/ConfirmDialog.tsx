import { useRef, useState, type ReactNode } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { cn } from '../lib/cn';
import { buttonClass } from '../primitives/buttonStyles';
import { Input } from '../primitives/Input';
import { Field } from '../primitives/Field';
import { Alert } from '../feedback/Alert';

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
        <AlertDialog.Backdrop className="motion-overlay fixed inset-0 z-[var(--z-overlay)] bg-overlay" />
        <AlertDialog.Popup
          initialFocus={cancelRef}
          className={cn(
            'motion-panel fixed left-1/2 top-1/2 z-[var(--z-overlay)] w-[calc(100vw-2rem)] max-w-md',
            '-translate-x-1/2 -translate-y-1/2',
            'rounded-xl border border-border bg-surface shadow-lg focus:outline-none',
          )}
        >
          <div className="px-5 py-4">
            <AlertDialog.Title className="text-lg font-semibold text-text-primary">
              {title}
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1.5 text-prose text-text-secondary">
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
              <Alert tone="danger" live className="mt-3">
                {error}
              </Alert>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 rounded-b-[inherit] border-t border-border bg-surface-sunken px-5 py-3">
            <AlertDialog.Close ref={cancelRef} className={buttonClass('ghost', 'md')} disabled={busy}>
              {cancelLabel}
            </AlertDialog.Close>
            {/* A plain button, not `AlertDialog.Close`: closing on click would
                tear down the busy state and the error surface before the request
                settles. */}
            <button
              type="button"
              onClick={handleConfirm}
              disabled={busy || !phraseSatisfied}
              aria-busy={busy || undefined}
              className={buttonClass(destructive ? 'danger' : 'primary', 'md')}
            >
              {busy ? 'Working…' : confirmLabel}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
