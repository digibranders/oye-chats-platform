import { type ReactNode, useState } from 'react';
import { Field, Input } from '../../../ui';

export interface NumberFieldProps {
  label: string;
  hint?: ReactNode;
  /** A validation failure for this control alone. Errors are never page-level. */
  error?: string | null;
  /** Display value, already converted into the unit named by `unitLabel`. */
  value: number;
  /**
   * The unit, appended to the visible label — "Greeting delay (seconds)".
   *
   * In the label rather than inside the field: a suffix rendered over a numeric
   * input collides with the browser's own spinner, and it is decorative, so a
   * screen reader announcing "Greeting delay, 3" leaves seconds and
   * milliseconds a factor of a thousand apart.
   */
  unitLabel?: string;
  /** Hide the label visually, for a `SettingRow` whose own label names the control. */
  hideLabel?: boolean;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  /** The raw input string. The caller parses and clamps it. */
  onChange: (raw: string) => void;
  className?: string;
}

/**
 * A numeric setting, composed from `Field` and `Input`.
 *
 * Not a new primitive — it adds no visual language of its own, only the typing
 * behaviour a number input needs everywhere on these two pages: while the field
 * has focus the user's raw keystrokes are shown verbatim, so a transient value
 * ("0.", "1.5") survives re-render instead of being reparsed and collapsed under
 * the caret. On blur the canonical parsed value returns. `onChange` still fires
 * per keystroke, so the page draft — and therefore the Save bar — stays in step.
 */
export function NumberField({
  label,
  hint,
  error,
  value,
  unitLabel,
  hideLabel = false,
  step = 1,
  min = 0,
  max,
  disabled = false,
  onChange,
  className,
}: NumberFieldProps) {
  const [buffer, setBuffer] = useState<string | null>(null);

  return (
    <Field
      label={unitLabel ? `${label} (${unitLabel})` : label}
      hideLabel={hideLabel}
      hint={hint}
      error={error ?? null}
      disabled={disabled}
      className={className}
    >
      <Input
        type="number"
        inputMode="decimal"
        value={buffer ?? value}
        step={step}
        min={min}
        max={max}
        onFocus={(event) => setBuffer(event.target.value)}
        onChange={(event) => {
          setBuffer(event.target.value);
          onChange(event.target.value);
        }}
        onBlur={() => setBuffer(null)}
      />
    </Field>
  );
}
