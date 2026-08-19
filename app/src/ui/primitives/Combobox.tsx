import { useMemo, useState, type ReactNode } from 'react';
import { Command } from 'cmdk';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { cn } from '../lib/cn';
import { PopoverRoot, PopoverTrigger, PopoverContent } from '../overlays/Popover';
import { CONTROL_BASE } from './Input';
import { useFieldControlProps } from './fieldContext';

export interface ComboboxOption<T extends string> {
  value: T;
  label: string;
  /** Second line, e.g. an email under a name. */
  description?: string;
  /** Extra text matched by the filter but not displayed. */
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
  /** Allow choosing nothing. Adds a "Clear" row when a value is set. */
  clearable?: boolean;
  className?: string;
}

/**
 * A searchable single-select.
 *
 * Deliberately a different component from `Select`, not a heavier one. A native
 * `<select>` is the right control for a short fixed list — it brings type-ahead,
 * the mobile wheel picker, and every platform's own conventions for free. This
 * exists for the cases a native select genuinely cannot serve: long lists,
 * two-line rows, and filtering.
 *
 * Built on `cmdk` inside a portalled `Popover`, so the list escapes any ancestor
 * with `overflow: hidden` or a transform. The previous `Select` rendered its
 * list absolutely inside its own wrapper and was clipped whenever it opened
 * inside a scrolling dialog.
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
  clearable = false,
  className,
}: ComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const fieldProps = useFieldControlProps();
  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled}
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
        </button>
      </PopoverTrigger>

      {/* `w-[var(--radix-popover-trigger-width)]` so the list matches the control
          it belongs to instead of floating at some unrelated width. */}
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-56 p-0">
        <Command
          // Our own filter, so `keywords` participates and matching is a simple
          // case-insensitive substring rather than cmdk's fuzzy scoring — which
          // ranks surprising results first in a list of proper nouns.
          filter={(itemValue, search, keywords) => {
            const haystack = `${itemValue} ${keywords?.join(' ') ?? ''}`.toLowerCase();
            return haystack.includes(search.toLowerCase()) ? 1 : 0;
          }}
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
            <Command.Input
              placeholder={searchPlaceholder}
              className="h-9 w-full bg-transparent text-base text-text-primary outline-none placeholder:text-text-disabled"
            />
          </div>
          <Command.List className="max-h-64 overflow-y-auto p-1">
            <Command.Empty className="px-2 py-6 text-center text-xs text-text-secondary">
              {emptyMessage}
            </Command.Empty>
            {clearable && selected ? (
              <Command.Item
                value="__clear__"
                keywords={['clear', 'none']}
                onSelect={() => {
                  onValueChange(null);
                  setOpen(false);
                }}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-base text-text-secondary data-[selected=true]:bg-surface-hover"
              >
                Clear selection
              </Command.Item>
            ) : null}
            {options.map((option) => (
              <Command.Item
                key={option.value}
                value={option.label}
                keywords={option.keywords ? [option.keywords] : undefined}
                disabled={option.disabled}
                onSelect={() => {
                  onValueChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-base text-text-primary',
                  'data-[selected=true]:bg-surface-hover',
                  'data-[disabled=true]:pointer-events-none data-[disabled=true]:text-text-disabled',
                )}
              >
                {option.icon ? <span className="mt-0.5 shrink-0">{option.icon}</span> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.label}</span>
                  {option.description ? (
                    <span className="block truncate text-xs text-text-secondary">{option.description}</span>
                  ) : null}
                </span>
                {option.value === value ? (
                  <Check aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-600" />
                ) : null}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </PopoverRoot>
  );
}
