import { useState, type ReactNode } from 'react';
import { Dialog } from './Dialog';
import { Button } from '../primitives/Button';
import { Input } from '../primitives/Input';
import { Field } from '../primitives/Field';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** State the consequence in full. "This cannot be undone" on its own is not one. */
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  destructive?: boolean;
  /**
   * Demand the user type this exact string before confirming.
   *
   * Reserve it for actions that destroy work that cannot be recreated — deleting
   * an agent and its whole knowledge base, closing an account. Asking for it on
   * a routine delete trains people to type past it, which is worse than not
   * asking.
   */
  confirmPhrase?: string;
  confirmPhraseLabel?: string;
}

/**
 * A blocking confirmation.
 *
 * One component, rather than the previous app's mixture of inline two-button
 * swaps, per-page bespoke modals, and a `ConfirmProvider` that was written and
 * never mounted. An inline confirm that replaces a row's action cell is easy to
 * miss and easy to hit by accident on touch; a dialog states what will happen
 * and makes the user answer it.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  destructive = true,
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
      // The caller decides what "done" means; it closes the dialog itself so a
      // failure that it handles by showing an inline error can keep the dialog
      // open with the user's typed phrase intact.
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function handleOpenChange(next: boolean) {
    // Never let the dialog close while the action is in flight: the user cannot
    // tell a cancelled request from a completed one.
    if (busy) return;
    if (!next) {
      setTyped('');
      setError(null);
    }
    onOpenChange(next);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={title}
      size="sm"
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={handleConfirm}
            loading={busy}
            disabled={!phraseSatisfied}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="text-base leading-relaxed text-text-secondary">{description}</div>

        {confirmPhrase ? (
          <Field
            label={confirmPhraseLabel ?? `Type ${confirmPhrase} to confirm`}
            error={error}
          >
            <Input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              // Not autofocused: focus landing in a text field means the first
              // Enter submits a destructive action the user has not read yet.
              placeholder={confirmPhrase}
            />
          </Field>
        ) : error ? (
          <p role="alert" className="text-xs leading-relaxed text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
