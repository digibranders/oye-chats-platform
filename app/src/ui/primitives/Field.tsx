import { useId, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '../lib/cn';
import { FieldContext } from './fieldContext';
import { useTranslation } from '../../i18n/useTranslation';

export interface FieldProps {
  label: string;
  children: ReactNode;
  /** Guidance shown before the user acts. Keep it to one line. */
  hint?: ReactNode;
  /** A validation failure. Shown below the hint, never instead of it. */
  error?: string | null;
  /**
   * The value must be supplied: `aria-required`, plus " (required)" in the
   * accessible name.
   *
   * **It draws no asterisk.** The console marks the *exception*, not the rule —
   * see `optional`. A red `*` on every field of a form where every field is
   * required carries no information at all: the sign-in card showed six of them
   * and none of them told the reader anything they could act on. Where a form
   * genuinely mixes, the shorter list is almost always the optional one, and
   * "Optional" is a word rather than a glyph the reader has to have been taught.
   */
  required?: boolean;
  /**
   * Marks the field as skippable, in the label rather than in the hint.
   *
   * This is the console's only visible requiredness marker, and the convention
   * is deliberate: mark what can be skipped, because that is what the reader can
   * act on. Around twenty hints in the console began with the word "Optional." —
   * which spends the one line of guidance the field has on a fact that belongs
   * beside the label, and reads as prose rather than as a property of the
   * control.
   */
  optional?: boolean;
  /**
   * A control or a note on the label's trailing edge — a "reset to default"
   * link, a character count, a badge saying where the value came from.
   *
   * It goes here rather than in `Input trailing` because that slot is *inside*
   * the field: a conditional affix there changes the input's element tree, and
   * React remounts the input and eats the caret mid-typing. Two surfaces worked
   * around it by rendering an always-present `invisible` badge, which is a
   * layout hole that reserves space for something that is usually not there.
   *
   * The label row becomes a `justify-between` pair capped at
   * `--container-pair`, so this never drifts a screen away from the label.
   */
  trailing?: ReactNode;
  /**
   * Where the `trailing` element sits on the label row.
   *
   * `'pair'` (default) caps the row at `--container-pair` so the label and its
   * trailing control stay bound — the right choice when the trailing element is
   * a note or reset link with nothing beneath it to align to.
   *
   * `'edge'` drops the cap so the trailing element aligns to the field's right
   * edge. Use it when the control below is full-width and the trailing element
   * governs it — e.g. a switch that enables the input under it: at `'pair'` the
   * switch stops short of the input's right edge and reads as floating mid-row.
   */
  trailingAlign?: 'pair' | 'edge';
  disabled?: boolean;
  /** Hides the label visually but keeps it for assistive tech. */
  hideLabel?: boolean;
  /**
   * Hold one line of space for the hint and the error.
   *
   * Defaults to *whether the caller wired validation at all*: a `Field` given an
   * `error` prop — even `null` — is one an error can appear in, so the row is
   * reserved and nothing below it moves when the form is submitted. A field with
   * no `error` prop can never produce one, so it costs nothing. Submitting a
   * form with three invalid fields used to push every control below each one
   * down 24px while the user was looking at it, and desynchronised the two
   * columns of any `grid md:grid-cols-2`.
   */
  reserveMessageSpace?: boolean;
  className?: string;
}

/**
 * A labelled form control, with its hint and its error.
 *
 * Layout is fixed on purpose — label, control, hint, error. Letting each screen
 * choose produced forms where the hint sat above the control on one page and
 * below it on the next.
 *
 * The hint is **not** replaced by the error. An earlier version swapped them,
 * which removed the format guidance ("at least 8 characters, one number") at
 * exactly the moment the user had failed to meet it.
 *
 * The label carries its own id as well as `htmlFor`. A `<label for>` names only
 * an id-addressable control, so a `Field` wrapping a `RadioCards` or a
 * `SegmentedControl` — both `role="radiogroup"` divs — rendered a label pointing
 * at nothing. Those read `labelId` and set `aria-labelledby` instead, which is
 * why `FieldSet` is no longer the only way to name a group.
 */
export function Field({
  label,
  children,
  hint,
  error,
  required = false,
  optional = false,
  trailing,
  trailingAlign = 'pair',
  disabled = false,
  hideLabel = false,
  reserveMessageSpace,
  className,
}: FieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const reserve = reserveMessageSpace ?? error !== undefined;

  return (
    <FieldContext.Provider
      value={{ id, labelId, descriptionId, errorId, invalid: Boolean(error), required, disabled }}
    >
      <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
        {(() => {
          const labelNode = (
            <label
              id={labelId}
              htmlFor={id}
              className={cn(
                'text-base font-medium text-text-primary',
                hideLabel && 'sr-only',
                disabled && 'text-text-disabled',
              )}
            >
              {label}
              {/* Announced, never drawn. See `required` above: the visible
                  marker in this system is "Optional", on the fields that have
                  one. */}
              {required ? <span className="sr-only"> ({t('ds.required') || 'required'})</span> : null}
              {optional && !required ? (
                <span className="ms-1.5 text-xs font-normal text-text-tertiary">{t('ds.optional') || 'Optional'}</span>
              ) : null}
            </label>
          );
          if (!trailing) return labelNode;
          return (
            // Capped, like every other label→control pair in the system: past
            // about 640px the eye stops binding the two ends of a row. `'edge'`
            // opts out of the cap to align the trailing control to the field's
            // right edge, over a full-width control beneath it.
            <div
              className={cn(
                'flex items-center justify-between gap-3',
                trailingAlign === 'edge' ? 'w-full' : 'max-w-pair',
              )}
            >
              {labelNode}
              {/* Outside the field's context, on purpose. The trailing slot
                  holds a control that is NOT this field's control: a reset
                  button, a switch that gates the input below. A Switch there
                  read the same context as the input and took the field's id,
                  so two elements shared one id, `<label for>` resolved to the
                  switch's hidden checkbox, the input lost its accessible name
                  and clicking the label flipped the switch. A null context is
                  what every control sees outside a Field, and every control
                  already handles it. */}
              <span className="flex shrink-0 items-center gap-2">
                <FieldContext.Provider value={null}>{trailing}</FieldContext.Provider>
              </span>
            </div>
          );
        })()}

        {children}

        {hint || error || reserve ? (
          // One region, always the height of one `text-xs` line when reserved,
          // so a single-line error costs no reflow.
          <div className={cn('flex flex-col gap-1', reserve && 'min-h-4.5')}>
            {hint ? (
              // A `div`, not a `p`. The slot takes a `ReactNode` and the two
              // hints that most needed it — an accepted-formats list and a
              // password rule set — are `<ul>`s, which a `<p>` may not contain:
              // the browser closes the paragraph early and the list lands
              // outside the element `aria-describedby` points at. Both call
              // sites had abandoned the slot and hand-rolled the text below the
              // field instead, unwired.
              <div id={descriptionId} className="text-xs text-text-secondary">
                {hint}
              </div>
            ) : null}
            {error ? (
              <p
                id={errorId}
                // Polite, not assertive: an error announced mid-keystroke
                // interrupts the user typing the very value that would clear it.
                role="status"
                aria-live="polite"
                className="flex items-start gap-1.5 text-xs text-danger"
              >
                <AlertCircle aria-hidden className="mt-px h-icon-sm w-icon-sm shrink-0" />
                <span>{error}</span>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

/**
 * A labelled group of related controls — a radio set, a row of switches.
 *
 * A `fieldset` rather than a `div` with a heading, so the group's name is
 * announced with each control inside it. Without it, "Weekly" and "Monthly" are
 * read as two loose radios with no indication of what they are choosing between.
 *
 * Its internal rhythm is `Field`'s, not its own. It was 4px under the legend and
 * 10px above the controls against `Field`'s 6/6, so a `FieldSet` and a `Field`
 * stacked in one card did not share a vertical rhythm.
 */
export function FieldSet({
  legend,
  hint,
  disabled = false,
  children,
  className,
}: {
  legend: string;
  hint?: ReactNode;
  /**
   * Disables every control in the group, in one place.
   *
   * The native attribute, not a prop threaded to each child: `fieldset[disabled]`
   * is inherited by every form control inside it by the HTML spec, including
   * ones added later, and it survives a child that forgot to read the flag. The
   * legend and the hint take `--color-text-disabled` to say so — never an
   * opacity wash, which compounds with each control's own disabled treatment.
   *
   * Base UI's `Checkbox`, `Switch` and `Select` render spans rather than form
   * controls and are *not* covered by the inherited attribute, so a group of
   * those still needs a `Field disabled` around it or the prop on each.
   */
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    // Not a flex column: a `<legend>` is laid out by the fieldset itself, and
    // browsers disagree about where it lands once the fieldset becomes a flex
    // container. Explicit margins reach the same 6/6 rhythm safely.
    <fieldset disabled={disabled} className={cn('min-w-0', className)}>
      <legend
        className={cn(
          'text-base font-medium',
          disabled ? 'text-text-disabled' : 'text-text-primary',
        )}
      >
        {legend}
      </legend>
      {hint ? (
        <div
          className={cn('mt-1.5 text-xs', disabled ? 'text-text-disabled' : 'text-text-secondary')}
        >
          {hint}
        </div>
      ) : null}
      <div className="mt-1.5">{children}</div>
    </fieldset>
  );
}
