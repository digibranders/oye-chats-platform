import { useMemo } from 'react';
import { Select as BaseSelect } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../lib/cn';
import { CONTROL_BASE } from './Input';
import { CONTROL_SIZE, controlClass } from './controlStyles';
import { PANEL_BASE, PANEL_POSITIONER } from '../overlays/panelStyles';
import { useFieldControlProps, useFieldNamesControl } from './fieldContext';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  options: readonly SelectOption<T>[];
  /** Omit for an uncontrolled select — see `defaultValue`. */
  value?: T;
  /** The initial value of an uncontrolled select. Mutually exclusive with `value`. */
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  /** Required: the control's accessible name. */
  label: string;
  /**
   * A first option the user cannot choose — "Select a department…".
   *
   * Use it when the field *must* end up with a value and simply has none yet.
   * When empty is a legitimate answer, use `emptyOption` instead: a disabled
   * placeholder cannot be selected, so a field with only a placeholder can be
   * set but never cleared.
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
  disabled?: boolean;
  /**
   * Whether the user must choose a value before submitting a form.
   *
   * Distinct from `disabled || Boolean(fieldProps.disabled)` above: this is
   * validation, not interactivity, so it only has an effect when the control
   * sits in a real `<form>`.
   */
  required?: boolean;
  /**
   * An explicit DOM id, for the one wiring `Field` cannot do: a `SettingRow`
   * names its control by `htmlFor` on a real `<label>` rather than by
   * `FieldContext`, so the caller has to hand the control the matching id
   * itself.
   */
  id?: string;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * A single-select, fully styled — the open list is ours, not platform chrome.
 *
 * `Select` used to render a native `<select>` on purpose: its own docblock
 * argued native type-ahead, the mobile wheel picker and every platform's own
 * keyboard conventions for free, at the cost of the *open list* being
 * unstyleable — on Windows, a `Select` inside a `Dialog` painted a system list
 * that ignored every token in this file. The console decided that price is no
 * longer acceptable: every dropdown in the product renders in the product's own
 * chrome, full stop.
 *
 * Base UI's `Select` gives this up for nothing behaviourally — arrow-key
 * navigation, Home/End, type-ahead and Escape all still work exactly as they do
 * on a native element, because the library implements the same contract on top
 * of a real hidden `<select>` it keeps in sync for form submission. Only the
 * *rendering* of the open list changes hands, which is the one part that was
 * ever the problem.
 *
 * Deliberately still a different component from `Combobox`, not merged into it:
 * a plain list of a dozen options gains nothing from a search box, and a search
 * box that filters five values is a control asking a question nobody has. Use
 * `Combobox` for a long list, a two-line row, or filtering; this is for a short
 * fixed one.
 */
export function Select<T extends string = string>({
  options,
  value,
  defaultValue,
  onValueChange,
  label,
  placeholder,
  emptyOption,
  disabled = false,
  required = false,
  id,
  size = 'md',
  className,
}: SelectProps<T>) {
  const fieldNamesIt = useFieldNamesControl();
  const fieldProps = useFieldControlProps();
  const geometry = CONTROL_SIZE[size];

  // `emptyOption` is a real, selectable leading row; `placeholder` is a
  // disabled one that only ever shows as the trigger's own hint text once a
  // real value replaces it. Passing both renders only `emptyOption` — see the
  // prop doc for why.
  const items = useMemo(() => {
    const leading = emptyOption
      ? [{ value: '' as T, label: emptyOption, disabled: false }]
      : placeholder
        ? [{ value: '' as T, label: placeholder, disabled: true }]
        : [];
    return [...leading, ...options];
  }, [emptyOption, placeholder, options]);
  const labelFor = useMemo(() => {
    const byValue = new Map(items.map((item) => [item.value, item.label]));
    return (v: unknown) => byValue.get(v as T);
  }, [items]);

  return (
    <BaseSelect.Root
      items={items}
      value={value}
      defaultValue={defaultValue}
      required={required}
      disabled={disabled || Boolean(fieldProps.disabled)}
      onValueChange={onValueChange ? (next) => onValueChange((next ?? '') as T) : undefined}
    >
      <BaseSelect.Trigger
        // Only self-labelling outside a `Field` — see `Combobox` for the full
        // reasoning; the same SC 2.5.3 failure applies here. An explicit `id`
        // means the caller is doing that wiring itself with a real `<label
        // htmlFor>` (the `SettingRow` pattern `id`'s own doc describes), so
        // this would double-name the control rather than name it.
        aria-label={fieldNamesIt || id ? undefined : label}
        className={cn(
          CONTROL_BASE,
          'flex items-center justify-between gap-2 text-left',
          controlClass(size),
          className,
        )}
        {...fieldProps}
        {...(id ? { id } : {})}
      >
        {/* `Select.Value` reads the store directly, so it is correct whether the
            select is controlled, uncontrolled, or has no listener at all —
            unlike deriving the label from the `value` prop here, which would
            print the placeholder forever on an uncontrolled select. */}
        <BaseSelect.Value
          placeholder={placeholder}
          className="min-w-0 flex-1 truncate data-[placeholder]:text-text-disabled"
        >
          {(v: unknown) => labelFor(v) ?? placeholder ?? ''}
        </BaseSelect.Value>
        <BaseSelect.Icon>
          <ChevronDown aria-hidden className={cn('shrink-0 text-text-tertiary', geometry.icon)} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>

      <BaseSelect.Portal>
        <BaseSelect.Positioner
          className={PANEL_POSITIONER}
          sideOffset={6}
          collisionPadding={8}
          // The selected row overlapping the trigger — Base UI's default for
          // mouse input — is right for a menu but wrong for a form control:
          // this list is reached by keyboard as often as by mouse, and a panel
          // that opens flush under the trigger for one and on top of it for
          // the other is a control that moves. `Combobox` never had this
          // question because a combobox popup does not overlap by default.
          alignItemWithTrigger={false}
        >
          {/* Matched to the trigger's width, so the list belongs to the
              control it came from rather than floating at some unrelated
              size. */}
          <BaseSelect.Popup className={cn(PANEL_BASE, 'w-[var(--anchor-width)] min-w-52')}>
            <BaseSelect.List className="max-h-64 overflow-y-auto p-1">
              {items.map((item) => (
                <BaseSelect.Item
                  key={item.value}
                  value={item.value}
                  disabled={item.disabled}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-base text-text-primary',
                    'outline-none data-[highlighted]:bg-surface-hover',
                    'data-[disabled]:pointer-events-none data-[disabled]:text-text-disabled',
                  )}
                >
                  <BaseSelect.ItemText className="min-w-0 flex-1 truncate">
                    {item.label}
                  </BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator className="shrink-0 text-accent-600">
                    <Check aria-hidden className="h-icon-sm w-icon-sm" />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
