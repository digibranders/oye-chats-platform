import { type ReactElement } from 'react';
import { Badge, Button, ColorInput, Field, Well } from '../../../ui';
import {
  TEXT_CONTRAST_MIN,
  checkContrast,
  formatRatio,
  isHexColor,
  nearestAccessible,
  type ContrastConstraint,
} from './contrast';
import { useTranslation } from '../../../i18n/useTranslation';

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
 * **The control itself is `ColorInput` now.** This file used to compose a bare
 * `<input type="color">` with `Input`'s classes and say in writing that the
 * system had no colour input — which rendered three different ways across
 * Chrome, Firefox and Safari, because Firefox ignores padding on the element
 * entirely and Safari draws its own bezel. `src/ui` owns the swatch geometry
 * now. What stays here is the judgement: whether a pair clears 4.5:1 is domain
 * knowledge about where the widget paints that colour, not a property of a text
 * field.
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
  const { t } = useTranslation();
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
        <ColorInput
          value={value}
          onChange={onChange}
          swatches={swatches}
          disabled={disabled}
          aria-label={label}
        />

        {/* The `Well` the comment here used to describe by hand. It was the
            seventh copy of `rounded-md … px-3 py-2.5` in `features/`, at the
            only `rounded-sm` radius among them. */}
        <Well>
          <ul className="flex flex-col gap-1.5">
            {checks.map((check) => (
              <li key={check.label} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="min-w-0 text-xs text-text-secondary">{check.label}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="figure text-xs text-text-primary">{formatRatio(check.ratio)}</span>
                  {check.verdict === 'pass' ? (
                    <Badge tone="success">{t('agents.readable') || 'Readable'}</Badge>
                  ) : check.verdict === 'fail' ? (
                    <Badge tone="danger">Below {check.min}:1</Badge>
                  ) : (
                    <Badge tone="neutral">{t('agents.notAColour') || 'Not a colour'}</Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Well>

        {failing.length > 0 ? (
          <p className="flex flex-wrap items-center gap-2 text-xs text-danger">
            <span className="min-w-0">
              {failing.length === 1
                ? `${failing[0].label} is hard to read at this contrast.`
                : `${failing.length} pairs are hard to read at this contrast.`}{' '}
              {t('agents.roughlyOneVisitorInTwelve') || 'Roughly one visitor in twelve will struggle with it.'}
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
