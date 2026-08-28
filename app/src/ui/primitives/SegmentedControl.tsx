import { useRef, type KeyboardEvent } from 'react';
import { cn } from '../lib/cn';
import { useFieldGroupProps } from './fieldContext';

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
  /**
   * Stretch the segments to fill the container instead of sizing to their
   * labels — for a control that owns a full-width row above a list.
   */
  fill?: boolean;
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
 *
 * **The container owns the height; the segments fill it.** It was the other way
 * round, so a `sm` control computed to 24 + 4 of padding + 2 of border = 30px —
 * a height no other control in the system has, which meant the filter chips
 * stuck out a pixel top and bottom of every `sm` toolbar they sat in. Now `sm`
 * is 28 and `md` is 34 by construction, and the inner radius is the container's
 * 8 less its own 2px of padding = 6, which is what the segment is set to.
 *
 * The outer edge is `--color-border-strong`. This is a control the user
 * operates, and a 1.28:1 hairline is a divider — the whole control read as a
 * floating grey smudge on a card.
 */
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  label,
  size = 'md',
  fill = false,
  className,
}: SegmentedControlProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);
  const group = useFieldGroupProps();
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
      // Inside a `Field` the visible label names the group; outside one it names
      // itself. Both, and the visible text and the announced name disagree.
      aria-label={group['aria-labelledby'] ? undefined : label}
      aria-labelledby={group['aria-labelledby']}
      aria-describedby={group['aria-describedby']}
      onKeyDown={onKeyDown}
      className={cn(
        'items-center gap-0.5 rounded-md border border-border-strong bg-surface-sunken p-0.5',
        size === 'sm' ? 'h-control-sm' : 'h-control-md',
        fill ? 'flex w-full' : 'inline-flex',
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
            disabled={item.disabled || group.disabled}
            onClick={() => onChange(item.value)}
            className={cn(
              'inline-flex h-full min-w-0 items-center justify-center gap-1 rounded-sm font-medium',
              'transition-colors duration-[var(--dur-fast)]',
              // The global ring is offset 2px and each segment is inset 2px by
              // the container's own padding, so a focused segment's ring landed
              // exactly on the container's border and overhung its corner at
              // the ends. Offset 0 makes it hug the segment's own 6px radius.
              'focus-visible:outline-offset-0',
              'disabled:cursor-not-allowed disabled:text-text-disabled',
              size === 'sm' ? 'px-2 text-xs' : 'px-2.5 text-sm',
              fill && 'flex-1',
              active
                ? 'bg-surface text-text-primary shadow-xs'
                : 'text-text-secondary enabled:hover:text-text-primary',
            )}
          >
            <span className="min-w-0 truncate">{item.label}</span>
            {item.count !== undefined ? (
              // A rung below the label, so "Compact 36" does not read as one
              // string. No `/70` here either: an opacity modifier on a token
              // whose ratio was measured at full strength quietly drops it
              // below AA, which is the exact failure the token file prevents.
              <span className="figure shrink-0 text-2xs text-text-tertiary">{item.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
