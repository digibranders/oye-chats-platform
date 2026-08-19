import { useMemo, type ReactNode } from 'react';
import { Combobox as BaseCombobox } from '@base-ui/react/combobox';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { cn } from '../lib/cn';
import { CONTROL_BASE } from './Input';
import { useFieldControlProps } from './fieldContext';

export interface ComboboxOption<T extends string> {
  value: T;
  label: string;
  /** Second line, e.g. an email under a name. */
  description?: string;
  /** Extra text the filter matches but which is not displayed. */
  keywords?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface ComboboxProps<T extends string> {
  options: readonly ComboboxOption<T>[];
  value: T | null;
  onValueChange: (value: T | null) => void;
  /** Required: the control's accessible name. */
  label: string;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * A searchable single-select.
 *
 * Deliberately a different component from `Select`, not a heavier one. A native
 * `<select>` is the right control for a short fixed list — it brings type-ahead,
 * the mobile wheel picker, and every platform's own conventions for free. This
 * exists for the cases a native select cannot serve: long lists, two-line rows,
 * and filtering.
 *
 * The behaviour is Base UI's, and that is the point. An earlier version put
 * `role="combobox"` on a plain button with no `aria-controls`, no owned
 * `listbox` and no `aria-activedescendant` — the widely-copied pattern that
 * announces nothing as the user arrows through the options. Filtering,
 * highlighting, the ARIA relationships and the portalled positioning are all
 * owned by the library here, so there is nothing left for us to get wrong.
 */
export function Combobox<T extends string>({
  options,
  value,
  onValueChange,
  label,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyMessage = 'No matches',
  disabled = false,
  size = 'md',
  className,
}: ComboboxProps<T>) {
  const fieldProps = useFieldControlProps();
  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );

  return (
    <BaseCombobox.Root<ComboboxOption<T>, false>
      items={options as ComboboxOption<T>[]}
      value={selected}
      disabled={disabled || Boolean(fieldProps.disabled)}
      // Matched against the label plus any hidden keywords, as a plain
      // case-insensitive substring. Fuzzy scoring ranks surprising results
      // first in a list of proper nouns, which is what these lists are.
      itemToStringValue={(item) => `${item.label} ${item.keywords ?? ''}`}
      isItemEqualToValue={(item, current) => item.value === current?.value}
      onValueChange={(next) => onValueChange(next?.value ?? null)}
    >
      <BaseCombobox.Trigger
        aria-label={label}
        className={cn(
          CONTROL_BASE,
          'flex items-center justify-between gap-2 text-left',
          size === 'sm' ? 'h-control-sm px-2.5 text-xs' : 'h-control-md px-3 text-base',
          className,
        )}
        {...fieldProps}
      >
        <span className={cn('min-w-0 flex-1 truncate', !selected && 'text-text-disabled')}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronsUpDown aria-hidden className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
      </BaseCombobox.Trigger>

      <BaseCombobox.Portal>
        <BaseCombobox.Positioner sideOffset={6} collisionPadding={8}>
          {/* Matched to the trigger's width, so the list belongs to the control
              it came from rather than floating at some unrelated size. */}
          <BaseCombobox.Popup className="motion-pop z-[var(--z-overlay)] w-[var(--anchor-width)] min-w-56 rounded-lg border border-border bg-surface shadow-md focus:outline-none">
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
              <BaseCombobox.Input
                placeholder={searchPlaceholder}
                className="h-9 w-full bg-transparent text-base text-text-primary outline-none placeholder:text-text-disabled"
              />
            </div>
            <BaseCombobox.Empty className="px-2 py-6 text-center text-xs text-text-secondary">
              {emptyMessage}
            </BaseCombobox.Empty>
            <BaseCombobox.List className="max-h-64 overflow-y-auto p-1">
              {(option: ComboboxOption<T>) => (
                <BaseCombobox.Item
                  key={option.value}
                  value={option}
                  disabled={option.disabled}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-base text-text-primary',
                    'outline-none data-[highlighted]:bg-surface-hover',
                    'data-[disabled]:pointer-events-none data-[disabled]:text-text-disabled',
                  )}
                >
                  {option.icon ? <span className="mt-0.5 shrink-0">{option.icon}</span> : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label}</span>
                    {option.description ? (
                      <span className="block truncate text-xs text-text-secondary">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                  <BaseCombobox.ItemIndicator className="mt-0.5 shrink-0 text-accent-600">
                    <Check aria-hidden className="h-3.5 w-3.5" />
                  </BaseCombobox.ItemIndicator>
                </BaseCombobox.Item>
              )}
            </BaseCombobox.List>
          </BaseCombobox.Popup>
        </BaseCombobox.Positioner>
      </BaseCombobox.Portal>
    </BaseCombobox.Root>
  );
}
