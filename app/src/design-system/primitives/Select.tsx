import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '../lib/cn';

export interface SelectOption {
  /** The value committed to `onChange` when this option is picked. */
  value: string;
  /** The visible text for the option (and the type-ahead target). */
  label: string;
  /** Optional string matched against the search box (falls back to `label`). */
  search?: string;
  /** Render the option as non-selectable (skipped by keyboard navigation). */
  disabled?: boolean;
}

export interface SelectProps {
  /** id for the trigger button - pair with a `<label htmlFor>`. */
  id?: string;
  /** Currently selected option value (`''` = nothing selected). */
  value: string;
  /** Called with the picked option's `value`. */
  onChange: (value: string) => void;
  /** The options to render, in display order. */
  options: SelectOption[];
  /** Trigger text shown while nothing is selected. */
  placeholder?: string;
  /** Show a filter box in the open panel (for long lists like countries). */
  searchable?: boolean;
  disabled?: boolean;
  /** Accessible label when no visible `<label>` is associated. */
  'aria-label'?: string;
  /** aria-describedby / aria-labelledby passthrough for form field wiring. */
  'aria-labelledby'?: string;
  'aria-invalid'?: boolean;
  name?: string;
  /** Extra classes for the trigger button. */
  className?: string;
}

/**
 * Select - the custom listbox that replaces the browser-default `<select>`.
 *
 * Keeps the native select interaction contract (click or ArrowDown/Enter/Space
 * to open, arrows + Home/End to move, type-ahead on option text, Enter/Space to
 * pick, Escape/Tab/outside-click to close) but renders with the design-system
 * `--ds-*` tokens so it matches `Input`, `Textarea`, and `Modal` in both themes.
 *
 * With `searchable`, the open panel gains a filter box (focused on open) -
 * typing narrows the list against each option's `search` string (falling back
 * to its label). Plain mode already type-aheads for short lists.
 */
export function Select({
  id,
  value,
  onChange,
  options,
  placeholder = 'Select…',
  searchable = false,
  disabled = false,
  name,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledby,
  'aria-invalid': ariaInvalid,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const q = query.trim().toLowerCase();
  const visible =
    searchable && q
      // Both sides are lowercased. Lowercasing only the fallback meant a
      // caller-supplied `search` was compared case-sensitively against an
      // already-lowercased query, so "arab" missed "Arabic (Saudi Arabia)" -
      // searching by a name's first letter matched nothing at all.
      ? options.filter((opt) => (opt.search || opt.label).toLowerCase().includes(q))
      : options;

  const selectedIndex = options.findIndex((opt) => opt.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  useEffect(() => {
    if (!open) return undefined;
    const onDocPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocPointerDown);
    return () => document.removeEventListener('mousedown', onDocPointerDown);
  }, [open]);

  useEffect(() => {
    if (open && searchable) searchRef.current?.focus();
  }, [open, searchable]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    node?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  function firstEnabledFrom(start: number, dir: 1 | -1): number {
    for (let i = start; i >= 0 && i < visible.length; i += dir) {
      if (!visible[i].disabled) return i;
    }
    return -1;
  }

  function openList() {
    if (disabled) return;
    setQuery('');
    const preferred = selectedIndex >= 0 && !searchable ? selectedIndex : 0;
    const target = firstEnabledFrom(preferred, 1);
    setActiveIndex(target === -1 ? firstEnabledFrom(0, 1) : target);
    setOpen(true);
  }

  function commit(index: number) {
    const opt = visible[index];
    if (opt && !opt.disabled) onChange(opt.value);
    setOpen(false);
  }

  function handleListNavKeys(event: ReactKeyboardEvent): boolean {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => {
        const next = firstEnabledFrom(Math.min(i + 1, visible.length - 1), 1);
        return next === -1 ? i : next;
      });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => {
        const prev = firstEnabledFrom(Math.max(i - 1, 0), -1);
        return prev === -1 ? i : prev;
      });
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(firstEnabledFrom(0, 1));
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(firstEnabledFrom(visible.length - 1, -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commit(activeIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === 'Tab') {
      setOpen(false);
    } else {
      return false;
    }
    return true;
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent) {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openList();
      }
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      commit(activeIndex);
      return;
    }
    if (handleListNavKeys(event)) return;
    if (!searchable && event.key.length === 1 && /\S/.test(event.key)) {
      // Type-ahead: next option whose label has a word starting with the key,
      // scanning forward from the highlight so repeats cycle through matches.
      const key = event.key.toLowerCase();
      for (let step = 1; step <= visible.length; step += 1) {
        const i = (activeIndex + step) % visible.length;
        if (visible[i].disabled) continue;
        const words = visible[i].label.toLowerCase().split(/\s+/);
        if (words.some((w) => w.startsWith(key))) {
          setActiveIndex(i);
          break;
        }
      }
    }
  }

  return (
    <div ref={rootRef} className="relative">
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <button
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        aria-invalid={ariaInvalid}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={handleTriggerKeyDown}
        className={cn(
          'flex h-10 w-full items-center justify-between gap-2 rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 text-left text-sm outline-none transition-colors',
          'focus-visible:border-[var(--ds-accent)] focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
          'disabled:cursor-not-allowed disabled:opacity-60',
          selected ? 'text-[var(--ds-text)]' : 'text-[var(--ds-text-subtle)]',
          className,
        )}
      >
        <span className="truncate">{selected ? selected.label : placeholder}</span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={cn(
            'shrink-0 text-[var(--ds-text-subtle)] transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div
          className={cn(
            'absolute z-50 mt-1 w-full overflow-hidden rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-lg)]',
          )}
        >
          {searchable && (
            <div className="flex items-center gap-2 border-b border-[var(--ds-border)] px-3 py-2">
              <Search size={14} aria-hidden="true" className="shrink-0 text-[var(--ds-text-subtle)]" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={handleListNavKeys}
                placeholder="Search…"
                className="w-full border-none bg-transparent p-0 text-sm text-[var(--ds-text)] outline-none placeholder:text-[var(--ds-text-subtle)]"
              />
            </div>
          )}
          <ul ref={listRef} id={listboxId} role="listbox" className="max-h-64 overflow-auto py-1">
            {visible.length === 0 && (
              <li className="px-3 py-2 text-sm text-[var(--ds-text-subtle)]">No matches</li>
            )}
            {visible.map((opt, index) => {
              // Options take pointer, not keyboard, interaction - the trigger
              // button (or search box) keeps focus and owns all key handling.
              const isSelected = opt.value === value;
              const isActive = index === activeIndex;
              return (
                <li
                  key={opt.value}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={opt.disabled || undefined}
                  onMouseEnter={() => !opt.disabled && setActiveIndex(index)}
                  onClick={() => commit(index)}
                  className={cn(
                    'flex items-center justify-between gap-2 px-3 py-2 text-sm',
                    opt.disabled
                      ? 'cursor-not-allowed text-[var(--ds-text-subtle)] opacity-60'
                      : 'cursor-pointer',
                    !opt.disabled && isActive && 'bg-[var(--ds-bg-hover)]',
                    isSelected
                      ? 'font-medium text-[var(--ds-accent-text)]'
                      : !opt.disabled && 'text-[var(--ds-text)]',
                  )}
                >
                  <span className="truncate">{opt.label}</span>
                  {isSelected && <Check size={14} aria-hidden="true" className="shrink-0" />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
