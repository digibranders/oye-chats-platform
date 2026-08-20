import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { useFieldGroupProps } from './fieldContext';

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
 *
 * **It draws a real radio mark.** Selection used to be a hue change on a 1px
 * border and a pale tint — colour as the only signal, in the one control in the
 * system whose entire job is expressing a choice, against DESIGN.md §1.4 and
 * §6.3. Printed, in forced-colors mode, or for the roughly one reader in twelve
 * who cannot separate those hues, a three-option group was three identical
 * paragraphs. The mark says which one is chosen; the accent border and the inset
 * ring only reinforce it.
 *
 * The card's edge is `--color-border-strong`, not the decorative hairline: at
 * 1.28:1 the *unselected* options had no visible boundary at all. The radius is
 * a control's 8, not a card's 10 — these are not cards, and a grid of 10px boxes
 * inside a 10px card reads as the nested cards DESIGN.md §4 forbids.
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
  const group = useFieldGroupProps();
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
      // Inside a `Field` the visible label names the group; outside one it names
      // itself. Never both.
      aria-label={group['aria-labelledby'] ? undefined : label}
      aria-labelledby={group['aria-labelledby']}
      aria-describedby={group['aria-describedby']}
      onKeyDown={onKeyDown}
      className={cn(
        // Two across at `md`, three only at `lg`: `sm` is 640px, where three
        // cards with a sentence each are about 200px wide on a tablet.
        'grid gap-2',
        columns === 2 && 'md:grid-cols-2',
        columns === 3 && 'md:grid-cols-2 lg:grid-cols-3',
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
            disabled={item.disabled || group.disabled}
            tabIndex={item.value === focusable ? 0 : -1}
            data-value={item.value}
            onClick={() => onChange(item.value)}
            className={cn(
              'flex flex-col items-start rounded-md border p-3 text-left',
              'transition-colors duration-[var(--dur-fast)]',
              'disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-sunken',
              selected
                // An inset box-shadow used as structure, which DESIGN.md §5
                // explicitly sanctions: it doubles the selected edge's weight
                // without reflowing the card, and it survives the focus outline
                // because an outline is a separate property.
                ? 'border-accent-500 bg-accent-50 shadow-[inset_0_0_0_1px_var(--color-accent-500)]'
                : 'border-border-strong bg-surface enabled:hover:border-text-tertiary enabled:hover:bg-surface-hover',
            )}
          >
            <span className="flex w-full items-start gap-2">
              {/* The mark, not the tint, is what says "chosen". */}
              <span
                aria-hidden
                className={cn(
                  'mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                  selected ? 'border-accent-500 bg-accent-500' : 'border-border-strong bg-surface',
                  item.disabled && 'border-border bg-surface-sunken',
                )}
              >
                {selected ? <span className="h-1.5 w-1.5 rounded-full bg-text-inverse" /> : null}
              </span>
              {/* One text column, so the description starts on the label's own
                  left edge rather than under the radio mark. */}
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex w-full items-center gap-2">
                  <span
                    className={cn(
                      'min-w-0 flex-1 text-base font-medium',
                      item.disabled ? 'text-text-disabled' : 'text-text-primary',
                    )}
                  >
                    {item.label}
                  </span>
                  {/* Never dimmed: on a locked card the badge is the plan lock,
                      and it is the one thing the reader needs in order to
                      understand why the card is unavailable. */}
                  {item.badge}
                </span>
                {item.description ? (
                  <span
                    id={descriptionId}
                    className={cn(
                      'text-xs',
                      item.disabled ? 'text-text-disabled' : 'text-text-secondary',
                    )}
                  >
                    {item.description}
                  </span>
                ) : null}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
