import { forwardRef, useId, type ReactNode } from 'react';
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { Check, Minus } from 'lucide-react';
import { cn } from '../lib/cn';
import { HIT_AREA } from './controlStyles';
import { useFieldControlProps } from './fieldContext';

/**
 * Checkbox and Switch.
 *
 * Base UI rather than a hand-rolled control because what these owe is larger
 * than it looks: label association, space/enter semantics, indeterminate as a
 * real ARIA state, form participation through a hidden native input, and RTL.
 * The system this replaces had seven separate toggle implementations and none
 * of them agreed. This is one, and its keyboard contract is not ours to get
 * wrong.
 *
 * The visual layer is entirely ours — Base UI ships no styles.
 *
 * Both controls are drawn at their designed size and *targeted* at 24px through
 * `HIT_AREA`. A 16px checkbox is the right mark beside a 14px label and the
 * wrong thing to ask someone to hit in a table row, which is exactly where the
 * select-row checkbox lives.
 *
 * Disabled is stated in tokens, never in opacity. A disabled checkbox with a
 * label was dimmed twice — 0.6 on the box and 0.6 on the wrapper — which
 * multiplies to 0.36 and left the control very nearly invisible; and because
 * only one of the two paths read the `Field`'s disabled state, the two ways of
 * disabling the same control did not look the same.
 *
 * ## Why the state classes are computed in JS
 *
 * **Base UI does not render a native disabled control here.** Both roots come
 * out as `<span role="switch" data-disabled aria-disabled="true" tabindex="-1">`
 * — a span, so that a disabled control stays discoverable — and a span never
 * matches `:disabled` or `:enabled`. Every `disabled:` and `enabled:` variant
 * this file used to carry was therefore dead CSS that compiled, passed review
 * and painted nothing: a disabled CHECKED switch rendered `--color-ink` at
 * opacity 1, pixel-identical to a live one, with only its label dimmed. The
 * same silence swallowed both hover rules.
 *
 * The two states are branched in TypeScript instead, off the same `isDisabled`
 * the label already reads. It is not a style preference: a variant that cannot
 * match is indistinguishable from one that has not been written yet, and
 * `controls.test.tsx` can assert a class string but not the absence of a
 * selector match.
 */

export type CheckedState = boolean | 'indeterminate';

export interface CheckboxProps {
  checked?: CheckedState;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: CheckedState) => void;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  value?: string;
  label?: ReactNode;
  description?: ReactNode;
  /** Required when there is no visible `label` — a table's select-row cell. */
  'aria-label'?: string;
  className?: string;
}

export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  { label, description, disabled, className, checked, defaultChecked, onCheckedChange, ...props },
  ref,
) {
  const fieldProps = useFieldControlProps();
  const generatedId = useId();
  const describedById = description ? `${generatedId}-description` : undefined;
  // Inside a `Field` the id comes from the field, which is what pairs the
  // field's own label with this control. Outside one there is no id at all, and
  // a `<label htmlFor={undefined}>` names nothing — so a checkbox with a
  // perfectly visible label announced as an unnamed checkbox. Fall back to our
  // own id so the visible label always associates.
  const controlId = (fieldProps.id as string | undefined) ?? `${generatedId}-control`;
  const isDisabled = disabled ?? Boolean(fieldProps.disabled);

  // The public API takes one `CheckedState`, because a caller reasoning about a
  // select-all header thinks in three states, not in two booleans that can
  // disagree. Base UI splits them, so the translation happens here rather than
  // at every call site.
  const isIndeterminate = checked === 'indeterminate';

  const control = (
    <BaseCheckbox.Root
      ref={ref}
      checked={isIndeterminate ? false : checked}
      defaultChecked={defaultChecked}
      indeterminate={isIndeterminate}
      onCheckedChange={(next) => onCheckedChange?.(next)}
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded-xs border',
        'transition-colors duration-[var(--dur-fast)]',
        isDisabled
          ? cn(
              'cursor-not-allowed',
              'border-border bg-control-disabled',
              'data-[checked]:border-control-disabled-on data-[checked]:bg-control-disabled-on',
              'data-[indeterminate]:border-control-disabled-on data-[indeterminate]:bg-control-disabled-on',
            )
          : cn(
              'border-border-strong bg-surface',
              'data-[checked]:border-ink data-[checked]:bg-ink',
              'data-[indeterminate]:border-ink data-[indeterminate]:bg-ink',
            ),
        HIT_AREA,
        className,
      )}
      // The field's wiring first, so an explicit `disabled` on the control
      // still wins. `useFieldControlProps` omits keys rather than emitting
      // `undefined`, which would otherwise clobber the prop set beside it.
      {...fieldProps}
      id={label ? controlId : (fieldProps.id as string | undefined)}
      disabled={isDisabled}
      aria-describedby={
        [describedById, fieldProps['aria-describedby'] as string | undefined]
          .filter(Boolean)
          .join(' ') || undefined
      }
      {...props}
    >
      {/* Which glyph shows is driven by Base UI's own `data-indeterminate` on
          the indicator, not by reading `props.checked` — that is `undefined`
          for an uncontrolled checkbox, so an earlier version never showed the
          indeterminate dash at all. */}
      <BaseCheckbox.Indicator className="group flex items-center justify-center text-text-inverse">
        <Check
          aria-hidden
          strokeWidth={3}
          className="h-3 w-3 group-data-[indeterminate]:hidden"
        />
        <Minus
          aria-hidden
          strokeWidth={3}
          className="hidden h-3 w-3 group-data-[indeterminate]:block"
        />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );

  if (!label) return control;

  return (
    // Optical centring: a 16px box against a 22px line box only needs pushing
    // down when there is a second line under the label to pin it to.
    <div className={cn('flex gap-2', description ? 'items-start' : 'items-center')}>
      <span className={cn(description && 'mt-1')}>{control}</span>
      <span className="min-w-0">
        {/* The label is a sibling wired by `htmlFor`, not a wrapper. Nesting the
            description inside the label folds it into the control's accessible
            name, so the switch announces as "Enable live chat Route
            conversations to a human when your team is online". */}
        <label
          htmlFor={controlId}
          className={cn(
            'block text-base font-medium',
            isDisabled ? 'text-text-disabled' : 'cursor-pointer text-text-primary',
          )}
        >
          {label}
        </label>
        {description ? (
          <span
            id={describedById}
            className={cn(
              'mt-1 block text-xs',
              isDisabled ? 'text-text-disabled' : 'text-text-secondary',
            )}
          >
            {description}
          </span>
        ) : null}
      </span>
    </div>
  );
});

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Required — a bare switch has no accessible name. */
  label: string;
  /** Hides the label when a neighbouring row heading already names it. */
  hideLabel?: boolean;
  /**
   * Let the label/toggle row span its full container instead of the default
   * `max-w-pair` cap. Off by default, because past ~640px the eye stops binding
   * the two ends of a row (see the render note); opt in only where a wide panel
   * genuinely wants the toggle at its far edge.
   */
  fullWidth?: boolean;
  description?: ReactNode;
  disabled?: boolean;
  size?: 'sm' | 'md';
  name?: string;
  className?: string;
}

/**
 * A setting that takes effect immediately.
 *
 * Distinct from a checkbox, which is a value that takes effect when the form is
 * submitted. Choosing the wrong one is how a user presses Save and wonders why
 * nothing happened — or flips something they meant to review first.
 *
 * The track's geometry is deliberate and verified, so nobody "fixes" it: at
 * `md` the 36px track less 2 × 2px of padding leaves 32px of inner room, the
 * thumb is 16, and the travel is therefore exactly `translate-x-4`; at `sm`,
 * 28 − 4 = 24, thumb 12, travel `translate-x-3`. `--shadow-xs` on the thumb is
 * the 1px seam the token file documents, not elevation.
 *
 * The off track is `--color-neutral-fill`, not `--color-border-strong`.
 * `border-strong` is byte-identical to `--color-text-disabled`, so an *off*
 * switch was exactly the colour of disabled — and beside a genuinely disabled
 * switch the two states were nearly indistinguishable. Disabled now separates
 * the two states as well, in its own pair of tokens: a disabled-on track is
 * `--color-control-disabled-on` and a disabled-off track is
 * `--color-control-disabled`, 2.41 apart, so the state survives being disabled
 * — which an opacity wash could never express, and which the previous
 * `disabled:` variants never got the chance to.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, label, hideLabel = false, fullWidth = false, description, disabled, size = 'md', name, className },
  ref,
) {
  const fieldProps = useFieldControlProps();
  const generatedId = useId();
  const describedById = description ? `${generatedId}-description` : undefined;
  // A switch needs no id fallback: it is a button, and a button is named by
  // `aria-label` or `aria-labelledby`, never by a sibling `<label htmlFor>`.
  const labelId = `${generatedId}-label`;
  const isDisabled = disabled ?? Boolean(fieldProps.disabled);

  const control = (
    <BaseSwitch.Root
      ref={ref}
      checked={checked}
      onCheckedChange={onCheckedChange}
      name={name}
      // A `switch` is a button, so a neighbouring `<span>` does not name it the
      // way a `<label htmlFor>` names an input. Without one of these two the
      // control has no accessible name at all — which is what the visible-label
      // path shipped with until a test asked for the name.
      aria-label={hideLabel ? label : undefined}
      aria-labelledby={hideLabel ? undefined : labelId}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full p-0.5',
        'transition-colors duration-[var(--dur-fast)]',
        isDisabled
          ? cn(
              'cursor-not-allowed',
              'data-[checked]:bg-control-disabled-on data-[unchecked]:bg-control-disabled',
            )
          : cn(
              'data-[checked]:bg-ink data-[unchecked]:bg-neutral-fill',
              'hover:data-[checked]:bg-ink-hover hover:data-[unchecked]:bg-text-tertiary',
            ),
        size === 'sm' ? 'h-4 w-7' : 'h-5 w-9',
        HIT_AREA,
        className,
      )}
      {...fieldProps}
      disabled={isDisabled}
      aria-describedby={
        [describedById, fieldProps['aria-describedby'] as string | undefined]
          .filter(Boolean)
          .join(' ') || undefined
      }
    >
      <BaseSwitch.Thumb
        className={cn(
          'block rounded-full bg-surface',
          // The seam is elevation-adjacent; a disabled control is not lifted.
          isDisabled ? 'shadow-none' : 'shadow-xs',
          'transition-transform duration-[var(--dur-fast)] ease-[var(--ease-console)]',
          // rtl-ok: a switch's "on" position follows reading direction: it
          // slides toward the inline end, which `translate-x` itself never
          // knows about (a transform offset is always physical), so the rtl
          // variant carries the mirrored, negative offset.
          size === 'sm'
            ? 'h-3 w-3 data-[checked]:translate-x-3 rtl:data-[checked]:-translate-x-3' // rtl-ok: see above
            : 'h-4 w-4 data-[checked]:translate-x-4 rtl:data-[checked]:-translate-x-4', // rtl-ok: see above
        )}
      />
    </BaseSwitch.Root>
  );

  if (hideLabel) return control;

  return (
    // Capped at `--container-pair`. A `justify-between` row inside a 1440px card
    // put a switch 1,540px from the label naming it; past about 640px the eye
    // stops binding the two ends of a row and the middle reads as a hole.
    <div className={cn('flex items-start justify-between gap-4', fullWidth ? 'w-full' : 'max-w-pair')}>
      <span className="min-w-0">
        <span
          id={labelId}
          className={cn(
            'block text-base font-medium',
            isDisabled ? 'text-text-disabled' : 'text-text-primary',
          )}
        >
          {label}
        </span>
        {description ? (
          <span
            id={describedById}
            className={cn(
              'mt-1 block text-xs',
              isDisabled ? 'text-text-disabled' : 'text-text-secondary',
            )}
          >
            {description}
          </span>
        ) : null}
      </span>
      {control}
    </div>
  );
});
