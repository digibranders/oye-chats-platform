import { Button, CardFooter } from '../../ui';

export interface SaveBarProps {
  /** Whether the form differs from the server's copy. */
  dirty: boolean;
  /** The changed fields, read back — "Name and Website". */
  summary?: string;
  saving?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  saveLabel?: string;
  /** Blocks the save without hiding it, so the reason stays on screen. */
  disabled?: boolean;
}

/**
 * The footer of an editable settings card.
 *
 * Always rendered, never conditional. A save bar that appears only once
 * something is dirty moves the whole page down at the exact moment the user is
 * typing, and — worse — a user who has not seen it does not know a save is
 * required at all. It is present and inert until there is something to do.
 *
 * `aria-live` sits on the summary rather than on the buttons: the fact that
 * changed, and the one worth announcing, is *what* is unsaved.
 */
export function SaveBar({
  dirty,
  summary,
  saving = false,
  onSave,
  onDiscard,
  saveLabel = 'Save changes',
  disabled = false,
}: SaveBarProps) {
  return (
    <CardFooter className="justify-between">
      <p role="status" aria-live="polite" className="min-w-0 text-xs text-text-secondary">
        {dirty
          ? summary
            ? `Unsaved changes to ${summary}.`
            : 'You have unsaved changes.'
          : 'Everything here is saved.'}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" onClick={onDiscard} disabled={!dirty || saving}>
          Discard
        </Button>
        <Button onClick={onSave} disabled={!dirty || saving || disabled} loading={saving}>
          {saveLabel}
        </Button>
      </div>
    </CardFooter>
  );
}
