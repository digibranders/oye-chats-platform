import { type ReactElement, useState } from 'react';
import { Input, cn } from '../../../design-system';

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name - required because the visible label sits in the row. */
  label: string;
  disabled?: boolean;
}

/**
 * Toggle - an accessible on/off switch (`role="switch"`). Presentational: the
 * caller renders the visible label alongside and passes it here as the a11y name.
 */
export function Toggle({ checked, onChange, label, disabled = false }: ToggleProps): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
        checked ? 'bg-[var(--ds-accent)]' : 'bg-[var(--ds-border)]',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

interface NumberFieldProps {
  id: string;
  label: string;
  help?: string;
  /** Display value (already converted to the display unit). */
  value: number;
  /** Short unit suffix shown inside the field, e.g. "sec" or "ms". */
  unit?: string;
  /** Spoken form of the unit for assistive tech, e.g. "seconds". */
  unitLabel?: string;
  step: number;
  min: number;
  /** Raw input string; the caller parses + clamps. */
  onChange: (raw: string) => void;
}

/** NumberField - a labelled numeric input with a unit suffix and helper text. */
export function NumberField({
  id,
  label,
  help,
  value,
  unit,
  unitLabel,
  step,
  min,
  onChange,
}: NumberFieldProps): ReactElement {
  const describedBy = help ? `${id}-help` : undefined;
  // While the field is focused we display the user's raw keystrokes verbatim so
  // transient values ("0.", "1.5") survive re-render instead of being reparsed
  // and collapsed; on blur we revert to the canonical parsed+formatted value.
  // onChange still fires per keystroke so the parent draft stays in sync.
  const [buffer, setBuffer] = useState<string | null>(null);
  const displayValue = buffer !== null ? buffer : value;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium text-[var(--ds-text)]">
        {label}
        {unitLabel && <span className="sr-only"> (in {unitLabel})</span>}
      </label>
      <div className="relative">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          value={displayValue}
          step={step}
          min={min}
          aria-describedby={describedBy}
          onFocus={(event) => setBuffer(event.target.value)}
          onChange={(event) => {
            setBuffer(event.target.value);
            onChange(event.target.value);
          }}
          onBlur={() => setBuffer(null)}
          className={unit ? 'pr-14' : undefined}
        />
        {unit && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] font-medium text-[var(--ds-text-subtle)]"
          >
            {unit}
          </span>
        )}
      </div>
      {help && (
        <p id={describedBy} className="text-[12px] leading-relaxed text-[var(--ds-text-subtle)]">
          {help}
        </p>
      )}
    </div>
  );
}
