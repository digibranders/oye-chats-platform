import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../lib/cn';
import { CONTROL_BASE } from './Input';
import { CONTROL_SIZE, controlClass, type ControlSize } from './controlStyles';
import { useFieldControlProps } from './fieldContext';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string>
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'children'> {
  options: readonly SelectOption<T>[];
  size?: ControlSize;
  /**
   * A first option the user cannot choose — "Select a department…".
   *
   * Use it when the field *must* end up with a value and simply has none yet.
   * When empty is a legitimate answer, use `emptyOption` instead: a disabled
   * placeholder cannot be selected, so a field with only a placeholder can be
   * set but never cleared. That is exactly how the previous department picker
   * shipped — assign a department and there was no way back.
   */
  placeholder?: string;
  /**
   * A first option the user *can* choose, meaning "none". Its value is `''`.
   *
   * Mutually exclusive with `placeholder`; passing both renders only this one,
   * because two leading options that look the same and behave differently is
   * worse than either.
   */
  emptyOption?: string;
}

/**
 * The chevron's clearance from the longest option is a constant 8px at every
 * size. It was 2 / 6 / 10, because the glyph sat at a fixed inset while the
 * text padding scaled — at `sm` a long option visibly kissed the arrow.
 */
const TRAILING_PAD = { sm: 'pr-8', md: 'pr-9', lg: 'pr-10' } as const;

/**
 * A native `<select>`.
 *
 * Native on purpose. A custom listbox has to reimplement type-ahead, the mobile
 * wheel picker, and every platform's own keyboard conventions, and it gets one
 * of them wrong on every release. Where the choice genuinely needs search,
 * multi-select, or rich rows, that is a `Combobox` — a different control with a
 * different job — not a heavier `Select`.
 *
 * The consequence of `appearance-none` is worth stating so nobody files it
 * later: the closed control is ours, the **open list is platform chrome**. On
 * Windows a `Select` inside a `Dialog` paints a system list that ignores every
 * token in this file. That is the accepted price of the paragraph above.
 */
function SelectInner<T extends string = string>(
  { options, size = 'md', placeholder, emptyOption, className, value, ...props }: SelectProps<T>,
  ref: React.Ref<HTMLSelectElement>,
) {
  const fieldProps = useFieldControlProps();
  const geometry = CONTROL_SIZE[size];
  return (
    <div className="relative flex w-full items-center">
      <select
        ref={ref}
        value={value}
        className={cn(
          CONTROL_BASE,
          'peer cursor-pointer appearance-none',
          controlClass(size),
          TRAILING_PAD[size],
          className,
        )}
        {...fieldProps}
        {...props}
      >
        {emptyOption ? (
          <option value="">{emptyOption}</option>
        ) : placeholder ? (
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
      {/* `peer-disabled`: the box greyed out and the arrow stayed at full
          strength, so a disabled select looked half-enabled. */}
      <ChevronDown
        aria-hidden
        className={cn(
          'pointer-events-none absolute shrink-0 text-text-tertiary peer-disabled:text-text-disabled',
          geometry.affixInset.trailing,
          geometry.icon,
        )}
      />
    </div>
  );
}

export const Select = forwardRef(SelectInner) as <T extends string = string>(
  props: SelectProps<T> & { ref?: React.Ref<HTMLSelectElement> },
) => React.ReactElement;
