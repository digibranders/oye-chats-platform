import { useId, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '../lib/cn';
import { FieldContext } from './fieldContext';

export interface FieldProps {
  label: string;
  children: ReactNode;
  /** Guidance shown before the user acts. Keep it to one line. */
  hint?: ReactNode;
  /** A validation failure. Shown below the hint, never instead of it. */
  error?: string | null;
  required?: boolean;
  /**
   * Marks the field as skippable, in the label rather than in the hint.
   *
   * Around twenty hints in the console began with the word "Optional." — which
   * spends the one line of guidance the field has on a fact that belongs beside
   * the label, and reads as prose rather than as a property of the control.
   */
  optional?: boolean;
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
  disabled = false,
  hideLabel = false,
  reserveMessageSpace,
  className,
}: FieldProps) {
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
          {required ? (
            <>
              {/* `align-middle`, because an asterisk glyph sits at cap height:
                  a bare `*` after a 14px label renders as a tick floating well
                  above the x-height of the word it belongs to. */}
              <span aria-hidden className="ml-1 align-middle text-danger">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </>
          ) : null}
          {optional && !required ? (
            <span className="ml-1.5 text-xs font-normal text-text-tertiary">Optional</span>
          ) : null}
        </label>

        {children}

        {hint || error || reserve ? (
          // One region, always the height of one `text-xs` line when reserved,
          // so a single-line error costs no reflow.
          <div className={cn('flex flex-col gap-1', reserve && 'min-h-4.5')}>
            {hint ? (
              <p id={descriptionId} className="text-xs text-text-secondary">
                {hint}
              </p>
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
  children,
  className,
}: {
  legend: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    // Not a flex column: a `<legend>` is laid out by the fieldset itself, and
    // browsers disagree about where it lands once the fieldset becomes a flex
    // container. Explicit margins reach the same 6/6 rhythm safely.
    <fieldset className={cn('min-w-0', className)}>
      <legend className="text-base font-medium text-text-primary">{legend}</legend>
      {hint ? <p className="mt-1.5 text-xs text-text-secondary">{hint}</p> : null}
      <div className="mt-1.5">{children}</div>
    </fieldset>
  );
}
