import { useId, useState } from 'react';
import { cn } from '../lib/cn';
import { isHexColor } from '../lib/validators';
import { Input } from './Input';
import { CONTROL_SIZE } from './controlStyles';
import { useFieldNamesControl } from './fieldContext';

export interface ColorInputProps {
  value: string;
  onChange: (hex: string) => void;
  /** Recent or brand-derived quick picks — the colours a crawl found first. */
  swatches?: readonly string[];
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** Required: the pair of controls has one name, and it is not "colour". */
  'aria-label': string;
  className?: string;
}

/**
 * A colour value: the platform's own picker, the hex, and the quick picks.
 *
 * It exists because a feature said in writing that it did not — *"`src/ui` has
 * no colour input… It is reported as a gap rather than smuggled into the design
 * system from a feature"* — and the workaround was a bare `<input
 * type="color">`, whose native swatch is square-cornered inside a rounded box.
 * That is the owner's "corners are broken" complaint in the one place a
 * customer picks their brand colour. `CONTROL_BASE` now resets
 * `::-webkit-color-swatch`, so the swatch takes the field's own 4px corner.
 *
 * Native rather than a bespoke picker: the platform brings the eyedropper, the
 * recent-colours strip, the OS palette, and a keyboard path, and every hand-
 * rolled hue wheel in a web app gets at least one of those wrong.
 *
 * The two controls are one value, so only one of them carries the field's id and
 * the other is named explicitly. Letting both take the field's id would put the
 * same `id` on two elements and leave the label pointing at whichever the
 * browser found first.
 *
 * What it deliberately does not do is judge the colour. Whether a pair clears
 * 4.5:1 is domain knowledge about where that colour is painted, and that stays
 * with the feature that knows.
 */
export function ColorInput({
  value,
  onChange,
  swatches = [],
  size = 'md',
  disabled = false,
  'aria-label': label,
  className,
}: ColorInputProps) {
  const swatchId = useId();
  const fieldNamesIt = useFieldNamesControl();
  const valid = isHexColor(value);
  // The native picker only accepts a full six-digit hex, and handing it a
  // half-typed one makes Chrome reset its own swatch to black while the user is
  // still typing in the field beside it. So it holds the last complete value
  // instead — and the seed is an empty string rather than a literal black,
  // because a design system that bans raw hex should not need one to render a
  // colour input.
  const [lastValid, setLastValid] = useState(() => (valid ? value : ''));
  if (valid && lastValid !== value) setLastValid(value);

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Input
        id={swatchId}
        type="color"
        size={size}
        value={lastValid}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-label={`${label} — swatch`}
        className={cn('w-12 shrink-0 cursor-pointer p-1', CONTROL_SIZE[size].height)}
      />
      {/* Inside a `Field`, this is the control the visible label names — it is
          the one that can be read aloud and typed into — so it takes the id and
          adds no name of its own. */}
      <Input
        value={value}
        size={size}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        spellCheck={false}
        aria-label={fieldNamesIt ? undefined : label}
        aria-invalid={value.length > 0 && !valid ? true : undefined}
        className="figure w-32 shrink-0"
      />
      {swatches.length > 0 ? (
        <ul className="flex min-w-0 flex-wrap items-center gap-1.5">
          {swatches.map((swatch) => {
            const active = swatch.toLowerCase() === value.toLowerCase();
            return (
              <li key={swatch}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(swatch)}
                  aria-label={`Use ${swatch}`}
                  aria-pressed={active}
                  style={{ backgroundColor: swatch }}
                  // The selected swatch is marked by border WEIGHT, not by a
                  // tick: a glyph drawn on an arbitrary customer colour has no
                  // contrast guarantee, which would be an odd thing for this
                  // component of all of them to ship.
                  className={cn(
                    'h-6 w-6 rounded-xs',
                    active ? 'border-2 border-ink' : 'border border-border-strong',
                    'disabled:cursor-not-allowed disabled:border-border',
                  )}
                />
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
