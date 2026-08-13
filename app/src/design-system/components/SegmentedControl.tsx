import { type KeyboardEvent, type ReactElement, type ReactNode, useRef } from 'react';
import { cn } from '../lib/cn';

export interface SegmentedOption<T extends string | number> {
  /** The value reported to `onChange` when this segment is picked. */
  value: T;
  /** Visible segment label. Doubles as the option's accessible name. */
  label: ReactNode;
}

export interface SegmentedControlProps<T extends string | number> {
  options: readonly SegmentedOption<T>[];
  /** The currently selected option's value. */
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group. Required - a radio group without a name
   *  announces as an unlabelled set of choices. */
  ariaLabel: string;
  /** Disables every segment, e.g. while the selection's result is in flight. */
  disabled?: boolean;
  className?: string;
}

/**
 * SegmentedControl - a compact one-of-N picker (mandate shared component).
 *
 * A mutually-exclusive choice, so it implements the WAI-ARIA radio group
 * pattern rather than a row of independent toggles: `role="radiogroup"` /
 * `role="radio"` with `aria-checked`, a roving `tabIndex` (only the selected
 * segment is in the tab order), and arrow / Home / End navigation. Selection
 * follows focus - moving with the arrow keys picks the segment it lands on,
 * which is the expected behaviour for a radio group and keeps keyboard use to
 * a single keystroke per change. Arrow navigation wraps at both ends.
 *
 * Values are constrained to `string | number` so each segment has a stable
 * React key without the caller supplying one.
 *
 * Use `Tabs` instead when the choice swaps a panel of content; this is for
 * parameterising what a page already shows (a time window, a unit, a mode).
 */
export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled = false,
  className,
}: SegmentedControlProps<T>): ReactElement {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function selectAt(index: number): void {
    const option = options[index];
    if (!option) return;
    buttonRefs.current[index]?.focus();
    onChange(option.value);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    // The click path is blocked by the native `disabled` attribute; this keeps
    // the keyboard path from depending on a browser refusing to focus a
    // disabled button, so the two are locked by the same rule.
    if (disabled) return;
    const count = options.length;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        selectAt((index + 1) % count);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        selectAt((index - 1 + count) % count);
        break;
      case 'Home':
        event.preventDefault();
        selectAt(0);
        break;
      case 'End':
        event.preventDefault();
        selectAt(count - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-1 rounded-lg bg-[var(--ds-bg-sunken)] p-1',
        className,
      )}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttonRefs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[12px] transition-colors focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)] disabled:cursor-not-allowed disabled:opacity-50',
              selected
                ? 'bg-[var(--ds-bg-surface)] font-semibold text-[var(--ds-text)] shadow-[var(--ds-shadow-sm)]'
                : 'font-medium text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
