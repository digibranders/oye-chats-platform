import { useMemo, type ReactNode } from 'react';
import { Combobox as BaseCombobox } from '@base-ui/react/combobox';
import { Check, ChevronDown, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { CONTROL_BASE } from './Input';
import { CONTROL_SIZE, controlClass } from './controlStyles';
import { PANEL_BASE, PANEL_POSITIONER } from '../overlays/panelStyles';
import { useFieldControlProps, useFieldNamesControl } from './fieldContext';
import { useTranslation } from '../../i18n/useTranslation';

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
  /**
   * Offer a way back to "none".
   *
   * `Select` carries this lesson in its own docblock — a placeholder-only field
   * can be set but never cleared, which is how the previous department picker
   * shipped. The `T | null` signature here could always express the empty
   * answer; until this prop, the UI could not produce it.
   */
  clearable?: boolean;
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
 *
 * The search row carries no magnifier. It had one, and the icon plus its gap
 * pushed the text the user types to a 34px indent while the option labels it
 * filters started at 12 — the most visible mis-alignment in any dropdown in the
 * app. The placeholder already says "Search…", so the glyph was buying nothing
 * and costing 22px of disagreement.
 *
 * The trigger's chevron is `ChevronDown`, the same glyph `Select` uses.
 * `ChevronsUpDown` is a listbox-trigger convention; this control is a dropdown
 * with search, and the two sat in adjacent grid cells announcing the same
 * affordance with two different icons at two different sizes.
 */
export function Combobox<T extends string>({
  options,
  value,
  onValueChange,
  label,
  placeholder: placeholderProp,
  searchPlaceholder: searchPlaceholderProp,
  emptyMessage: emptyMessageProp,
  clearable = false,
  disabled = false,
  size = 'md',
  className,
}: ComboboxProps<T>) {
  const { t } = useTranslation();
  // `??` would also swallow an explicit `null`; a default parameter
  // only applies to `undefined`, and callers pass null to opt OUT.
  const placeholder = placeholderProp === undefined ? (t('ds.selectPlaceholder') || 'Select…') : placeholderProp;
  // `??` would also swallow an explicit `null`; a default parameter
  // only applies to `undefined`, and callers pass null to opt OUT.
  const searchPlaceholder = searchPlaceholderProp === undefined ? (t('ds.search') || 'Search…') : searchPlaceholderProp;
  // `??` would also swallow an explicit `null`; a default parameter
  // only applies to `undefined`, and callers pass null to opt OUT.
  const emptyMessage = emptyMessageProp === undefined ? (t('ds.noMatches') || 'No matches') : emptyMessageProp;
  const fieldNamesIt = useFieldNamesControl();
  const fieldProps = useFieldControlProps();
  const geometry = CONTROL_SIZE[size];
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
        // Only self-labelling outside a `Field`. Inside one the visible
        // `<label>` is wired by `htmlFor`, but `aria-label` wins the accessible
        // name computation — so a field labelled "Search" announced as "Search
        // leads", which is an SC 2.5.3 Label-in-Name failure the gallery was
        // modelling as correct usage.
        aria-label={fieldNamesIt ? undefined : label}
        className={cn(
          CONTROL_BASE,
          'flex items-center justify-between gap-2 text-left',
          controlClass(size),
          className,
        )}
        {...fieldProps}
      >
        <span className={cn('min-w-0 flex-1 truncate', !selected && 'text-text-disabled')}>
          {selected?.label ?? placeholder}
        </span>
        {clearable && selected ? (
          // `role="button"` on a span, not a nested `<button>`: the trigger is
          // itself a button, and a button inside a button is invalid and is
          // dropped by the parser in some engines.
          <span
            role="button"
            tabIndex={-1}
            aria-label={`Clear ${label}`}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.preventDefault();
              onValueChange(null);
            }}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
          >
            <X aria-hidden className="h-icon-sm w-icon-sm" />
          </span>
        ) : null}
        <ChevronDown aria-hidden className={cn('shrink-0 text-text-tertiary', geometry.icon)} />
      </BaseCombobox.Trigger>

      <BaseCombobox.Portal>
        <BaseCombobox.Positioner
          className={PANEL_POSITIONER}
          sideOffset={6}
          collisionPadding={8}
        >
          {/* Matched to the trigger's width, so the list belongs to the control
              it came from rather than floating at some unrelated size. */}
          <BaseCombobox.Popup className={cn(PANEL_BASE, 'w-[var(--anchor-width)] min-w-52')}>
            {/* 12px of inset, which is where the option labels below start:
                4px of list padding plus the item's own 8px. */}
            <div className="border-b border-border px-3">
              <BaseCombobox.Input
                placeholder={searchPlaceholder}
                className="h-control-md w-full bg-transparent text-base text-text-primary outline-none placeholder:text-text-disabled"
              />
            </div>
            {/* A fixed floor under the list region, so the panel does not jump
                from 270px to 96px as the user types past the last match. */}
            <div className="min-h-16">
              {/* `Empty`'s root always renders — Base UI uses it as the live
                  region that announces result counts — and only its children are
                  conditional. Padding on the root is therefore dead space above
                  every non-empty list, so it goes on the child instead. */}
              <BaseCombobox.Empty>
                <p className="px-2 py-4 text-center text-xs text-text-secondary">{emptyMessage}</p>
              </BaseCombobox.Empty>
              <BaseCombobox.List className="max-h-64 overflow-y-auto p-1">
                {(option: ComboboxOption<T>) => (
                  <BaseCombobox.Item
                    key={option.value}
                    value={option}
                    disabled={option.disabled}
                    className={cn(
                      'flex cursor-pointer gap-2 rounded-sm px-2 py-1.5 text-base text-text-primary',
                      // Single-line rows centre; only a row with a second line
                      // needs its glyphs pinned to the first one.
                      option.description ? 'items-start' : 'items-center',
                      'outline-none data-[highlighted]:bg-surface-hover',
                      'data-[disabled]:pointer-events-none data-[disabled]:text-text-disabled',
                    )}
                  >
                    {option.icon ? (
                      <span className={cn('shrink-0', option.description && 'mt-1')}>
                        {option.icon}
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{option.label}</span>
                      {option.description ? (
                        <span className="block truncate text-xs text-text-secondary">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {/* 4px, not 2: optically centring a 14px glyph in a 22px
                        line box needs (22 − 14) / 2. */}
                    <BaseCombobox.ItemIndicator
                      className={cn('shrink-0 text-accent-600', option.description && 'mt-1')}
                    >
                      <Check aria-hidden className="h-icon-sm w-icon-sm" />
                    </BaseCombobox.ItemIndicator>
                  </BaseCombobox.Item>
                )}
              </BaseCombobox.List>
            </div>
          </BaseCombobox.Popup>
        </BaseCombobox.Positioner>
      </BaseCombobox.Portal>
    </BaseCombobox.Root>
  );
}
