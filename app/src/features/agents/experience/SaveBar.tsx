import { type ReactElement } from 'react';
import { AlertCircle, Check } from 'lucide-react';
import { Button } from '../../../ui';
import { SECTION_LABELS, type SectionKey } from './experience-model';

/**
 * Unsaved work, made visible and recoverable.
 *
 * **An explicit save bar rather than autosave-with-undo**, and the choice is
 * about blast radius rather than taste. Every field on this page is published:
 * the moment it is written it is what the customer's visitors read, on the
 * customer's own website. Autosave would push a half-typed greeting live for
 * however long it took to finish the sentence, and "undo" over a value the
 * public has already seen is not an undo. Autosave earns its place on private,
 * low-stakes state — a filter, a layout preference, a personal setting — and
 * this is the opposite of all three.
 *
 * So the contract is: the draft is local, the bar appears the moment it
 * diverges, it names *where* the unsaved work is rather than only that some
 * exists, and Discard puts everything back. Leaving the page while it is up is
 * intercepted — in-app by the router, and on a real navigation by the browser's
 * own prompt.
 *
 * The bar is `position: sticky` inside the editor column rather than fixed to
 * the viewport, so it can never cover the preview or a field near the bottom of
 * the form (WCAG 2.2 SC 2.4.11).
 */

export interface SaveBarProps {
  visible: boolean;
  dirtySections: readonly SectionKey[];
  saving: boolean;
  saveError: string | null;
  /** Timestamp of the last successful save, for the transient confirmation. */
  savedAt: number | null;
  /** True when a field-level error is blocking the save. */
  blocked: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

function summarize(sections: readonly SectionKey[]): string {
  const names = sections.map((section) => SECTION_LABELS[section]);
  if (names.length === 0) return '';
  if (names.length === 1) return `Unsaved changes in ${names[0]}`;
  const last = names[names.length - 1];
  return `Unsaved changes in ${names.slice(0, -1).join(', ')} and ${last}`;
}

export function SaveBar({
  visible,
  dirtySections,
  saving,
  saveError,
  savedAt,
  blocked,
  onSave,
  onDiscard,
}: SaveBarProps): ReactElement | null {
  if (!visible) return null;
  const dirty = dirtySections.length > 0;

  return (
    <div className="sticky bottom-0 z-[var(--z-sticky)] -mx-1 mt-2 px-1 pb-1">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-strong bg-surface px-4 py-3 shadow-md">
        <p
          // Polite and non-atomic: the bar is a running status, and an assertive
          // region here would interrupt the user on every keystroke that made
          // the form dirty.
          role="status"
          aria-live="polite"
          className="flex min-w-0 items-center gap-2 text-base"
        >
          {saveError ? (
            <>
              <AlertCircle aria-hidden className="h-4 w-4 shrink-0 text-danger" />
              <span className="text-danger">{saveError}</span>
            </>
          ) : saving ? (
            <span className="text-text-secondary">Saving…</span>
          ) : dirty ? (
            <span className="text-text-primary">
              {summarize(dirtySections)}
              {blocked ? (
                <span className="text-danger"> — fix the highlighted fields to save.</span>
              ) : null}
            </span>
          ) : savedAt !== null ? (
            <>
              <Check aria-hidden className="h-4 w-4 shrink-0 text-success" />
              <span className="text-text-secondary">Saved. Visitors see it now.</span>
            </>
          ) : null}
        </p>
        <span className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onDiscard} disabled={!dirty || saving}>
            Discard
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onSave}
            loading={saving}
            disabled={!dirty || blocked}
          >
            Save changes
          </Button>
        </span>
      </div>
    </div>
  );
}
