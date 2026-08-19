import { useRef, type KeyboardEvent } from 'react';
import { cn } from '../lib/cn';

export interface SegmentedItem<T extends string> {
  value: T;
  label: string;
  /** A result count. Shown after the label. */
  count?: number;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  items: readonly SegmentedItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Required: the control's own name, e.g. "Conversation status". */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * A row of mutually exclusive choices that filters something already on screen.
 *
 * `radiogroup`, not `tablist`. It does not switch between panels, so calling it
 * a tablist would promise `aria-controls` targets that do not exist — and a
 * tablist that filters is exactly how the previous app ended up firing its
 * upgrade modal when a keyboard user arrowed past a locked segment.
 *
 * The group is one tab stop with arrow-key movement inside it (the APG roving
 * tabindex pattern). A row of five segments that each take their own tab stop
 * makes a filter bar cost five presses to walk past.
 *
 * Past about five items this stops working — the segments get too narrow to read
 * and the row starts wrapping — and the right control becomes a `Select`.
 */
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  label,
  size = 'md',
  className,
}: SegmentedControlProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);
  const enabled = items.filter((item) => !item.disabled);

  function move(delta: number) {
    if (enabled.length === 0) return;
    const current = enabled.findIndex((item) => item.value === value);
    const next = enabled[(current + delta + enabled.length) % enabled.length];
    onChange(next.value);
    // Focus follows selection, which is correct here: a radiogroup selects on
    // arrow by definition, and every option is a cheap client-side filter.
    groupRef.current
      ?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)
      ?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'Home':
        event.preventDefault();
        if (enabled[0]) onChange(enabled[0].value);
        break;
      case 'End':
        event.preventDefault();
        if (enabled.at(-1)) onChange(enabled.at(-1)!.value);
        break;
      default:
        break;
    }
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
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
            role="radio"
            data-value={item.value}
            aria-checked={active}
            // Roving tabindex: only the selected segment is in the tab order.
            tabIndex={active ? 0 : -1}
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
              // No `/70` here. An opacity modifier on a token whose ratio was
              // measured at full strength quietly drops it below AA — which is
              // the exact failure the token file exists to prevent.
              <span className="figure text-text-tertiary">{item.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
