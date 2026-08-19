import { type ReactElement, useId } from 'react';
import { Badge, Button, Field, Input, cn } from '../../../ui';
import {
  TEXT_CONTRAST_MIN,
  checkContrast,
  formatRatio,
  isHexColor,
  nearestAccessible,
  type ContrastConstraint,
} from './contrast';

/**
 * A colour, with the contrast it produces.
 *
 * The console's own palette was built by measuring every pair and writing the
 * ratio next to the token. The colours a customer picks here are painted onto
 * their website, in front of their visitors, and get the same treatment: each
 * pair the colour takes part in is named, measured, and graded against the WCAG
 * bar that applies to it — 4.5:1 where text sits on it, 3:1 for a glyph or a
 * boundary.
 *
 * It does not block the save. It is the customer's brand, and a console that
 * refuses to let a company use its own colour is one they stop using. What it
 * refuses to do is call a failing pair fine: a failure is a red badge with the
 * measured number, and one button that swaps in the nearest shade of the same
 * hue that clears every bar on the card at once.
 *
 * **`src/ui` has no colour input**, so this composes a native `<input
 * type="color">` — which brings the platform's own picker, eyedropper and
 * keyboard handling — with the system's `Input` for the hex value. It is
 * reported as a gap rather than smuggled into the design system from a feature.
 *
 * The two of them are one value, so `Field` labels the hex box (it is the one
 * that can be read aloud and typed into) and the swatch carries its own name
 * with an explicit id. Letting both take the field's id would put the same
 * `id` on two elements and leave the label pointing at whichever the browser
 * found first.
 */

export interface ContrastPair {
  /** What sits on top. */
  foreground: string;
  /** What it sits on. */
  background: string;
  /** Named in full, e.g. "White text on your brand colour". */
  label: string;
  /** 4.5 for text, 3 for a glyph or a control edge. */
  min?: number;
}

export interface ColorFieldProps {
  label: string;
  hint: string;
  value: string;
  onChange: (hex: string) => void;
  /** Quick picks: the colours the crawl found on the customer's site, first. */
  swatches: readonly string[];
  /** Every pair this colour appears in, in the widget. */
  pairs: readonly ContrastPair[];
  error?: string | null;
  disabled?: boolean;
}

export function ColorField({
  label,
  hint,
  value,
  onChange,
  swatches,
  pairs,
  error,
  disabled = false,
}: ColorFieldProps): ReactElement {
  const pickerId = useId();
  const valid = isHexColor(value);
  const checks = pairs.map((pair) =>
    checkContrast(pair.foreground, pair.background, pair.label, pair.min ?? TEXT_CONTRAST_MIN),
  );
  const failing = checks.filter((check) => check.verdict === 'fail');

  // Every pair, expressed as a requirement on *this* colour: whichever side of
  // the pair is not the value being edited is the thing it must stay readable
  // against.
  const constraints: ContrastConstraint[] = pairs.map((pair) => ({
    against: pair.foreground.toLowerCase() === value.toLowerCase() ? pair.background : pair.foreground,
    min: pair.min ?? TEXT_CONTRAST_MIN,
  }));
  const suggestion = failing.length > 0 && valid ? nearestAccessible(value, constraints) : null;

  return (
    <Field label={label} hint={hint} error={error} disabled={disabled}>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <Input
            id={pickerId}
            type="color"
            // The native picker's own value must always be a colour, or Chrome
            // silently resets the swatch to black while the user is mid-typing
            // in the hex field beside it.
            value={valid ? value : '#000000'}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            aria-label={`${label} — swatch`}
            className="h-control-md w-12 shrink-0 cursor-pointer p-1"
          />
          {/* No `aria-label`: this is the control the field's own label names,
              so adding one would replace "Brand colour" with a second string. */}
          <Input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            spellCheck={false}
            inputMode="text"
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
                      // tick: a glyph drawn on an arbitrary customer colour has
                      // no contrast guarantee, which would be an odd thing for
                      // this component of all of them to ship.
                      className={cn(
                        'h-6 w-6 rounded-xs',
                        active ? 'border-2 border-ink' : 'border border-border-strong',
                        'disabled:cursor-not-allowed disabled:opacity-50',
                      )}
                    />
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>

        <ul className="flex flex-col gap-1.5 rounded-sm bg-surface-sunken px-3 py-2">
          {checks.map((check) => (
            <li key={check.label} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className="min-w-0 text-xs text-text-secondary">{check.label}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="figure text-xs text-text-primary">{formatRatio(check.ratio)}</span>
                {check.verdict === 'pass' ? (
                  <Badge tone="success">Readable</Badge>
                ) : check.verdict === 'fail' ? (
                  <Badge tone="danger">Below {check.min}:1</Badge>
                ) : (
                  <Badge tone="neutral">Not a colour</Badge>
                )}
              </span>
            </li>
          ))}
        </ul>

        {failing.length > 0 ? (
          <p className="flex flex-wrap items-center gap-2 text-xs leading-relaxed text-danger">
            <span className="min-w-0">
              {failing.length === 1
                ? `${failing[0].label} is hard to read at this contrast.`
                : `${failing.length} pairs are hard to read at this contrast.`}{' '}
              Roughly one visitor in twelve will struggle with it.
            </span>
            {suggestion ? (
              <Button variant="secondary" size="sm" onClick={() => onChange(suggestion)} disabled={disabled}>
                Use <span className="figure ml-1">{suggestion}</span>
              </Button>
            ) : null}
          </p>
        ) : null}
      </div>
    </Field>
  );
}
