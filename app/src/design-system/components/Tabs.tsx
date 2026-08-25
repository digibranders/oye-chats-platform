import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import { cn } from '../lib/cn';

export interface TabItem {
  key: string;
  label: ReactNode;
  /** Disable selection of this tab. */
  disabled?: boolean;
}

export interface TabsProps {
  tabs: readonly TabItem[];
  /** Key of the currently selected tab. */
  value: string;
  onChange: (key: string) => void;
  /** Accessible name for the tablist. */
  ariaLabel?: string;
  className?: string;
}

/**
 * Tabs - an accessible in-page tablist (mandate shared component). Implements
 * the WAI-ARIA tabs pattern: `role="tablist"`/`role="tab"`, `aria-selected`,
 * roving `tabIndex`, and arrow / Home / End keyboard navigation. The caller
 * renders the panel for `value` (associate it via `aria-controls`/`id` as
 * needed).
 *
 * The strip scrolls horizontally rather than overflowing. Without that, a set
 * of tabs wider than its column squashed its labels onto three lines and then
 * still spilled sideways underneath whatever sat beside it - on the agent
 * Experience page the last two tabs rendered under the preview panel, where
 * clicks landed on the panel instead of the tab. Scrolling keeps every tab
 * reachable at any width.
 */
export function Tabs({ tabs, value, onChange, ariaLabel, className }: TabsProps) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function focusTab(index: number): void {
    const tab = tabs[index];
    if (!tab || tab.disabled) return;
    buttonRefs.current[index]?.focus();
    onChange(tab.key);
  }

  function moveFocus(from: number, direction: 1 | -1): void {
    const count = tabs.length;
    for (let step = 1; step <= count; step += 1) {
      const next = (from + direction * step + count * step) % count;
      if (!tabs[next]?.disabled) {
        focusTab(next);
        return;
      }
    }
  }

  function firstEnabled(): number {
    return tabs.findIndex((tab) => !tab.disabled);
  }

  function lastEnabled(): number {
    for (let i = tabs.length - 1; i >= 0; i -= 1) {
      if (!tabs[i]?.disabled) return i;
    }
    return -1;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(index, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(index, -1);
        break;
      case 'Home': {
        event.preventDefault();
        const first = firstEnabled();
        if (first !== -1) focusTab(first);
        break;
      }
      case 'End': {
        event.preventDefault();
        const last = lastEnabled();
        if (last !== -1) focusTab(last);
        break;
      }
      default:
        break;
    }
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        // `max-w-full` caps the shrink-to-fit width at the container so there
        // is something to scroll; `pb-px` absorbs the tabs' `-mb-px` overhang,
        // which would otherwise count as a 1px vertical overflow and summon a
        // vertical scrollbar next to the horizontal one.
        'inline-flex max-w-full items-center gap-1 overflow-x-auto border-b border-[var(--ds-border)] pb-px',
        className,
      )}
    >
      {tabs.map((tab, index) => {
        const selected = tab.key === value;
        return (
          <button
            key={tab.key}
            ref={(node) => {
              buttonRefs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`tab-${tab.key}`}
            aria-selected={selected}
            aria-controls={`tabpanel-${tab.key}`}
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => !tab.disabled && onChange(tab.key)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              // `shrink-0`: a tab keeps its label on one line and scrolls out
              // of view instead of being compressed until the text wraps.
              '-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)] disabled:cursor-not-allowed disabled:opacity-40',
              selected
                ? 'border-[var(--ds-accent)] text-[var(--ds-accent-text)]'
                : 'border-transparent text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
