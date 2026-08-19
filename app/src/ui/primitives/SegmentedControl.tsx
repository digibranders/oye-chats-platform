import { cn } from '../lib/cn';

export interface SegmentedItem<T extends string> {
  value: T;
  label: string;
  /** Shown after the label. Use for result counts on a filter. */
  count?: number;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  items: readonly SegmentedItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /**
   * `tablist` when the control switches between panels — it then owes each tab
   * an `aria-controls` target, which `panelIdFor` supplies. `group` when it
   * filters something already on screen, where calling it a tablist would
   * promise panels that do not exist.
   */
  role?: 'tablist' | 'group';
  /** Required: the control's own name, e.g. "Conversation status". */
  label: string;
  panelIdFor?: (value: T) => string;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * A row of mutually exclusive choices.
 *
 * Says "pick exactly one of a few" in a way a row of loose buttons does not.
 * Past about five items it stops working — the segments get too narrow to read
 * and the control starts wrapping — and the right answer becomes a `Select`.
 */
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  role = 'group',
  label,
  panelIdFor,
  size = 'md',
  className,
}: SegmentedControlProps<T>) {
  const isTabs = role === 'tablist';

  return (
    <div
      role={role}
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border border-border bg-surface-sunken p-0.5',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role={isTabs ? 'tab' : undefined}
            id={isTabs ? `tab-${item.value}` : undefined}
            aria-selected={isTabs ? active : undefined}
            aria-controls={isTabs ? panelIdFor?.(item.value) : undefined}
            // A filter is a pressed/unpressed toggle, not a selected tab. Using
            // `aria-selected` outside a tablist is invalid and announces nothing.
            aria-pressed={isTabs ? undefined : active}
            disabled={item.disabled}
            onClick={() => onChange(item.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-sm font-medium',
              'transition-colors duration-[var(--dur-fast)]',
              'disabled:cursor-not-allowed disabled:opacity-50',
              size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-sm',
              active
                ? 'bg-surface text-text-primary shadow-xs'
                : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {item.label}
            {item.count !== undefined ? (
              <span className={cn('tnum', active ? 'text-text-tertiary' : 'text-text-tertiary/70')}>
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
