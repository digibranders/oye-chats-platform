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
  disabled?: boolean;
  /** Hides the label visually but keeps it for assistive tech. */
  hideLabel?: boolean;
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
 */
export function Field({
  label,
  children,
  hint,
  error,
  required = false,
  disabled = false,
  hideLabel = false,
  className,
}: FieldProps) {
  const id = useId();
  const descriptionId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <FieldContext.Provider
      value={{ id, descriptionId, errorId, invalid: Boolean(error), required, disabled }}
    >
      <div className={cn('flex flex-col gap-1.5', className)}>
        <label
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
              <span aria-hidden className="ml-0.5 text-danger">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </>
          ) : null}
        </label>

        {children}

        {hint ? (
          <p id={descriptionId} className="text-xs leading-relaxed text-text-secondary">
            {hint}
          </p>
        ) : null}

        {error ? (
          <p
            id={errorId}
            // Polite, not assertive: an error announced mid-keystroke interrupts
            // the user typing the very value that would clear it.
            role="status"
            aria-live="polite"
            className="flex items-start gap-1.5 text-xs leading-relaxed text-danger"
          >
            <AlertCircle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </p>
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
    <fieldset className={cn('min-w-0', className)}>
      <legend className="text-base font-medium text-text-primary">{legend}</legend>
      {hint ? <p className="mt-1 text-xs leading-relaxed text-text-secondary">{hint}</p> : null}
      <div className="mt-2.5">{children}</div>
    </fieldset>
  );
}
