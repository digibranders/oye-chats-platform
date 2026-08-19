import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../lib/cn';
import { CONTROL_BASE } from './Input';
import { useFieldControlProps } from './fieldContext';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string>
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'children'> {
  options: readonly SelectOption<T>[];
  size?: 'sm' | 'md' | 'lg';
  /** Renders a disabled first option. Omit when the field always has a value. */
  placeholder?: string;
}

const SIZES = {
  sm: 'h-[var(--control-h-sm)] pl-2.5 pr-7 text-xs',
  md: 'h-[var(--control-h-md)] pl-3 pr-8 text-base',
  lg: 'h-[var(--control-h-lg)] pl-3.5 pr-9 text-base',
} as const;

/**
 * A native `<select>`.
 *
 * Native on purpose. A custom listbox has to reimplement type-ahead, the mobile
 * wheel picker, and every platform's own keyboard conventions, and it gets one
 * of them wrong on every release. Where the choice genuinely needs search,
 * multi-select, or rich rows, that is a `Combobox` — a different control with a
 * different job — not a heavier `Select`.
 */
function SelectInner<T extends string = string>(
  { options, size = 'md', placeholder, className, value, ...props }: SelectProps<T>,
  ref: React.Ref<HTMLSelectElement>,
) {
  const fieldProps = useFieldControlProps();
  return (
    <div className="relative flex w-full items-center">
      <select
        ref={ref}
        value={value}
        className={cn(CONTROL_BASE, SIZES[size], 'appearance-none cursor-pointer', className)}
        {...fieldProps}
        {...props}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2.5 h-4 w-4 shrink-0 text-text-tertiary"
      />
    </div>
  );
}

export const Select = forwardRef(SelectInner) as <T extends string = string>(
  props: SelectProps<T> & { ref?: React.Ref<HTMLSelectElement> },
) => React.ReactElement;
