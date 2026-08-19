import { forwardRef, useId, type ReactNode } from 'react';
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { Check, Minus } from 'lucide-react';
import { cn } from '../lib/cn';
import { useFieldControlProps } from './fieldContext';

/**
 * Checkbox and Switch, on Radix.
 *
 * Base UI rather than a hand-rolled control because what these owe is larger
 * than it looks: label association, space/enter semantics, indeterminate as a real
 * ARIA state, form participation through a hidden native input, and RTL. The
 * system this replaces had seven separate toggle implementations and none of
 * them agreed. This is one, and its keyboard contract is not ours to get wrong.
 *
 * The visual layer is entirely ours — Radix ships no styles.
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
        'border-border-strong bg-surface transition-colors duration-[var(--dur-fast)]',
        'data-[checked]:border-ink data-[checked]:bg-ink',
        'data-[indeterminate]:border-ink data-[indeterminate]:bg-ink',
        'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-60',
        className,
      )}
      // The field's wiring first, so an explicit `disabled` on the control
      // still wins. `useFieldControlProps` omits keys rather than emitting
      // `undefined`, which would otherwise clobber the prop set beside it.
      {...fieldProps}
      disabled={disabled ?? (fieldProps.disabled as boolean | undefined)}
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
    <div className={cn('flex items-start gap-2.5', disabled && 'opacity-60')}>
      <span className="mt-0.5">{control}</span>
      <span className="min-w-0">
        {/* The label is a sibling wired by `htmlFor`, not a wrapper. Nesting the
            description inside the label folds it into the control's accessible
            name, so the switch announces as "Enable live chat Route
            conversations to a human when your team is online". */}
        <label
          htmlFor={(fieldProps.id as string | undefined) ?? undefined}
          className={cn('block text-base text-text-primary', !disabled && 'cursor-pointer')}
        >
          {label}
        </label>
        {description ? (
          <span id={describedById} className="mt-0.5 block text-xs leading-relaxed text-text-secondary">
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
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, label, hideLabel = false, description, disabled, size = 'md', name, className },
  ref,
) {
  const fieldProps = useFieldControlProps();
  const generatedId = useId();
  const describedById = description ? `${generatedId}-description` : undefined;
  const labelId = `${generatedId}-label`;

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
        'relative inline-flex shrink-0 items-center rounded-full p-0.5',
        'transition-colors duration-[var(--dur-fast)]',
        'data-[checked]:bg-ink data-[unchecked]:bg-border-strong',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-4 w-7' : 'h-5 w-9',
        className,
      )}
      {...fieldProps}
      disabled={disabled ?? (fieldProps.disabled as boolean | undefined)}
      aria-describedby={
        [describedById, fieldProps['aria-describedby'] as string | undefined]
          .filter(Boolean)
          .join(' ') || undefined
      }
    >
      <BaseSwitch.Thumb
        className={cn(
          'block rounded-full bg-surface shadow-xs',
          'transition-transform duration-[var(--dur-fast)] ease-[var(--ease-console)]',
          size === 'sm'
            ? 'h-3 w-3 data-[checked]:translate-x-3'
            : 'h-4 w-4 data-[checked]:translate-x-4',
        )}
      />
    </BaseSwitch.Root>
  );

  if (hideLabel) return control;

  return (
    <div className="flex items-start justify-between gap-4">
      <span className="min-w-0">
        <span id={labelId} className="block text-base font-medium text-text-primary">
          {label}
        </span>
        {description ? (
          <span id={describedById} className="mt-0.5 block text-xs leading-relaxed text-text-secondary">
            {description}
          </span>
        ) : null}
      </span>
      {control}
    </div>
  );
});
