import { forwardRef, type ReactNode } from 'react';
import * as RadixCheckbox from '@radix-ui/react-checkbox';
import * as RadixSwitch from '@radix-ui/react-switch';
import { Check, Minus } from 'lucide-react';
import { cn } from '../lib/cn';
import { useFieldControlProps } from './Field';

/**
 * Checkbox and Switch, on Radix.
 *
 * Radix rather than a hand-rolled control because the behaviour these owe is
 * larger than it looks: label association, space/enter semantics, indeterminate
 * as a real ARIA state, form participation through a hidden native input, and
 * RTL. The previous system had seven separate toggle implementations and none of
 * them agreed; this is one, and its keyboard contract is not ours to get wrong.
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
  /** Required when there is no visible `label`, e.g. a table's select-row cell. */
  'aria-label'?: string;
  className?: string;
}

export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  { label, description, disabled, className, ...props },
  ref,
) {
  const control = (
    <RadixCheckbox.Root
      ref={ref}
      disabled={disabled}
      className={cn(
        'peer flex h-4 w-4 shrink-0 items-center justify-center rounded-xs border',
        'border-border-strong bg-surface transition-colors duration-[var(--dur-fast)]',
        'data-[state=checked]:border-ink data-[state=checked]:bg-ink',
        'data-[state=indeterminate]:border-ink data-[state=indeterminate]:bg-ink',
        'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-60',
        className,
      )}
      {...props}
    >
      <RadixCheckbox.Indicator className="flex items-center justify-center text-text-inverse">
        {props.checked === 'indeterminate' ? (
          <Minus aria-hidden className="h-3 w-3" strokeWidth={3} />
        ) : (
          <Check aria-hidden className="h-3 w-3" strokeWidth={3} />
        )}
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );

  if (!label) return control;

  // A `label` element rather than Radix's id-wiring, so the description text is
  // part of the hit target too: a two-line option whose subtitle is not clickable
  // reads as broken on touch.
  return (
    <label className={cn('flex items-start gap-2.5', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
      <span className="mt-0.5">{control}</span>
      <span className="min-w-0">
        <span className="block text-base text-text-primary">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs leading-relaxed text-text-secondary">{description}</span>
        ) : null}
      </span>
    </label>
  );
});

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Required — a bare switch has no accessible name. */
  label: string;
  /** Hides the label visually when a neighbouring row heading already names it. */
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
  const control = (
    <RadixSwitch.Root
      ref={ref}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      name={name}
      aria-label={hideLabel ? label : undefined}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full p-0.5',
        'transition-colors duration-[var(--dur-fast)]',
        'data-[state=checked]:bg-ink data-[state=unchecked]:bg-border-strong',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-4 w-7' : 'h-5 w-9',
        className,
      )}
      {...fieldProps}
    >
      <RadixSwitch.Thumb
        className={cn(
          'block rounded-full bg-surface shadow-xs',
          'transition-transform duration-[var(--dur-fast)] ease-[var(--ease-console)]',
          size === 'sm'
            ? 'h-3 w-3 data-[state=checked]:translate-x-3'
            : 'h-4 w-4 data-[state=checked]:translate-x-4',
        )}
      />
    </RadixSwitch.Root>
  );

  if (hideLabel) return control;

  return (
    <div className="flex items-start justify-between gap-4">
      <span className="min-w-0">
        <span className="block text-base font-medium text-text-primary">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs leading-relaxed text-text-secondary">{description}</span>
        ) : null}
      </span>
      {control}
    </div>
  );
});
