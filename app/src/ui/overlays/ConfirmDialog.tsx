import { useState, type ReactNode } from 'react';
import * as RadixAlertDialog from '@radix-ui/react-alert-dialog';
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
   * deleting an agent and its whole knowledge base, closing an account. Asking
   * for it on a routine delete trains people to type past it, which is worse
   * than not asking at all.
   */
  confirmPhrase?: string;
  confirmPhraseLabel?: string;
}

/**
 * A blocking confirmation.
 *
 * A Radix `AlertDialog`, not a plain dialog: it carries `role="alertdialog"`, it
 * cannot be dismissed by clicking outside, and focus lands on Cancel rather than
 * on the destructive button. Those are exactly the differences that matter when
 * the next keypress deletes something.
 *
 * One component, rather than the previous app's mixture of inline two-button
 * swaps, per-page bespoke modals, and a `ConfirmProvider` that was written and
 * never mounted — which is how seven equally destructive actions ended up with
 * no confirmation at all, including promoting a member to Owner.
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
    <RadixAlertDialog.Root open={open} onOpenChange={handleOpenChange}>
      <RadixAlertDialog.Portal>
        <RadixAlertDialog.Overlay className="motion-overlay fixed inset-0 z-[var(--z-overlay)] bg-overlay" />
        <RadixAlertDialog.Content
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          className={cn(
            'motion-panel fixed left-1/2 top-1/2 z-[var(--z-overlay)] w-[calc(100vw-2rem)] max-w-md',
            '-translate-x-1/2 -translate-y-1/2',
            'rounded-xl border border-border bg-surface shadow-lg focus:outline-none',
          )}
        >
          <div className="px-5 py-4">
            <RadixAlertDialog.Title className="text-base font-semibold text-text-primary">
              {title}
            </RadixAlertDialog.Title>
            <RadixAlertDialog.Description className="mt-1.5 text-prose text-text-secondary">
              {description}
            </RadixAlertDialog.Description>

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
            <RadixAlertDialog.Cancel className={buttonClass('ghost', 'md')} disabled={busy}>
              {cancelLabel}
            </RadixAlertDialog.Cancel>
            {/* Not `AlertDialog.Action`: that closes the dialog on click, which
                would tear down the busy state and the error surface before the
                request settles. */}
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
        </RadixAlertDialog.Content>
      </RadixAlertDialog.Portal>
    </RadixAlertDialog.Root>
  );
}
