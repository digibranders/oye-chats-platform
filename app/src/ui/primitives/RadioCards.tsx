import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { useFieldControlProps } from './fieldContext';

export interface RadioCardItem<T extends string> {
  value: T;
  label: string;
  /** One line saying what choosing this actually does. The reason this exists. */
  description?: ReactNode;
  /** A plan lock, a "recommended", a count. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface RadioCardsProps<T extends string> {
  items: readonly RadioCardItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Required: the group's own name, e.g. "How strictly should it answer?". */
  label: string;
  /** Two or three across on wide viewports; one below `sm`. */
  columns?: 1 | 2 | 3;
  className?: string;
}

/**
 * A choice where each option needs a sentence.
 *
 * `SegmentedControl` is the right control when the options are one word each and
 * the user already knows what they mean — a status filter, a date range. It is
 * the wrong one the moment an option needs explaining, because it has room for a
 * label and nothing else. Three surfaces in this rebuild hit that wall and each
 * worked around it differently: one put the selected option's description under
 * the control (so you cannot compare before choosing), one used a `Select` with
 * a live region beside it, and one shipped the labels bare.
 *
 * This is the APG radiogroup pattern with room to read: one tab stop for the
 * whole group, arrow keys inside it, and selection following focus — which is
 * correct for a radiogroup and cheap here, because every option is a local state
 * change, not a fetch.
 *
 * Not a set of checkboxes and not a `fieldset` of native radios: a native radio
 * beside a two-line description puts the description inside the control's
 * accessible name unless every label is wired by hand, which is precisely the
 * mistake the toggle primitives already document.
 */
export function RadioCards<T extends string>({
  items,
  value,
  onChange,
  label,
  columns = 1,
  className,
}: RadioCardsProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const fieldProps = useFieldControlProps();
  const enabled = items.filter((item) => !item.disabled);

  function move(delta: number): void {
    if (enabled.length === 0) return;
    const current = enabled.findIndex((item) => item.value === value);
    const next = enabled[(current + delta + enabled.length) % enabled.length];
    onChange(next.value);
    groupRef.current
      ?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)
      ?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
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

  // Exactly one card is in the tab order. When the current value matches no
  // option — a stored value the plan no longer offers — the first enabled card
  // takes the tab stop, so the group cannot become unreachable by keyboard.
  const focusable =
    items.some((item) => item.value === value && !item.disabled) ? value : enabled[0]?.value;

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      aria-describedby={fieldProps['aria-describedby'] as string | undefined}
      onKeyDown={onKeyDown}
      className={cn(
        'grid gap-2',
        columns === 2 && 'sm:grid-cols-2',
        columns === 3 && 'sm:grid-cols-3',
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.value === value;
        const descriptionId = item.description ? `${baseId}-${item.value}-description` : undefined;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={selected}
            // The name is the label alone. Without this it is computed from the
            // card's contents, so it becomes "Strict Only answers from your
            // documents." — the description folded into the name, which is the
            // exact defect this control exists to avoid. The description stays
            // reachable, as a description.
            aria-label={item.label}
            aria-describedby={descriptionId}
            disabled={item.disabled}
            tabIndex={item.value === focusable ? 0 : -1}
            data-value={item.value}
            onClick={() => onChange(item.value)}
            className={cn(
              'flex flex-col items-start gap-1 rounded-lg border p-3 text-left',
              'transition-colors duration-[var(--dur-fast)]',
              'disabled:cursor-not-allowed disabled:opacity-60',
              selected
                ? 'border-accent-500 bg-accent-50'
                : 'border-border bg-surface hover:bg-surface-hover',
            )}
          >
            <span className="flex w-full items-center gap-2">
              <span className="min-w-0 flex-1 text-base font-medium text-text-primary">
                {item.label}
              </span>
              {item.badge}
            </span>
            {item.description ? (
              <span id={descriptionId} className="text-xs leading-relaxed text-text-secondary">
                {item.description}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
