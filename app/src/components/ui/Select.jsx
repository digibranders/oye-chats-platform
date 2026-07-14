import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * Select — custom dropdown replacing the browser-default <select>.
 *
 * Same listbox interaction contract as a native select (click or
 * ArrowDown/Enter/Space to open, arrows + Home/End to move, type-ahead on
 * option text, Enter/Space to pick, Escape/Tab/outside-click to close) but
 * rendered with the app's surface/primary tokens so it matches Input and
 * Dialog in both themes.
 *
 * With `searchable`, the open panel gains a filter box (focused on open) —
 * typing narrows the list against each option's `search` string (falls back
 * to its label). Use for long lists like countries; plain mode already
 * type-aheads for short ones.
 *
 * @param {object} props
 * @param {string} [props.id] - id for the trigger button (pairs with a <label htmlFor>).
 * @param {string} props.value - currently selected option value ('' = none).
 * @param {(value: string) => void} props.onChange - called with the picked option's value.
 * @param {Array<{value: string, label: string, search?: string}>} props.options
 * @param {string} [props.placeholder] - trigger text while nothing is selected.
 * @param {boolean} [props.searchable] - show a filter box in the open panel.
 * @param {boolean} [props.disabled]
 * @param {string} [props.className] - extra classes for the trigger button.
 */
export default function Select({
  id,
  value,
  onChange,
  options,
  placeholder = 'Select…',
  searchable = false,
  disabled = false,
  className,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const searchRef = useRef(null);
  const listboxId = useId();

  const q = query.trim().toLowerCase();
  const visible =
    searchable && q
      ? options.filter((opt) => (opt.search || opt.label.toLowerCase()).includes(q))
      : options;

  const selectedIndex = options.findIndex((opt) => opt.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  useEffect(() => {
    if (!open) return undefined;
    const onDocPointerDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocPointerDown);
    return () => document.removeEventListener('mousedown', onDocPointerDown);
  }, [open]);

  useEffect(() => {
    if (open && searchable) searchRef.current?.focus();
  }, [open, searchable]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  function openList() {
    if (disabled) return;
    setQuery('');
    setActiveIndex(selectedIndex >= 0 && !searchable ? selectedIndex : 0);
    setOpen(true);
  }

  function commit(index) {
    const opt = visible[index];
    if (opt) onChange(opt.value);
    setOpen(false);
  }

  function handleListNavKeys(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, visible.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(visible.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(activeIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Tab') {
      setOpen(false);
    } else {
      return false;
    }
    return true;
  }

  function handleTriggerKeyDown(e) {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      commit(activeIndex);
      return;
    }
    if (handleListNavKeys(e)) return;
    if (!searchable && e.key.length === 1 && /\S/.test(e.key)) {
      // Type-ahead: next option whose label has a word starting with the key,
      // scanning forward from the highlight so repeats cycle through matches.
      const key = e.key.toLowerCase();
      for (let step = 1; step <= visible.length; step += 1) {
        const i = (activeIndex + step) % visible.length;
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
      <button
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={handleTriggerKeyDown}
        className={cn(
          'w-full px-3 py-2 rounded-xl border border-surface-200 dark:border-surface-600 text-sm',
          'bg-white dark:bg-surface-800 text-left',
          'focus:ring-1 focus:ring-[var(--focus-ring)] focus:border-[var(--focus)] outline-none transition-all',
          'disabled:opacity-60 disabled:cursor-not-allowed',
          'flex items-center justify-between gap-2',
          selected
            ? 'text-surface-900 dark:text-surface-100'
            : 'text-surface-400 dark:text-surface-500',
          className,
        )}
      >
        <span className="truncate">{selected ? selected.label : placeholder}</span>
        <ChevronDown
          className={cn(
            'w-4 h-4 shrink-0 text-surface-400 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div
          className={cn(
            'absolute z-50 mt-1 w-full rounded-xl overflow-hidden',
            'border border-surface-200 dark:border-surface-600',
            'bg-white dark:bg-surface-800 shadow-lg',
          )}
        >
          {searchable && (
            <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-100 dark:border-surface-700">
              <Search className="w-3.5 h-3.5 shrink-0 text-surface-400" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={handleListNavKeys}
                placeholder="Search…"
                className={cn(
                  'w-full bg-transparent text-sm outline-none border-none p-0',
                  'text-surface-900 dark:text-surface-100',
                  'placeholder:text-surface-400 dark:placeholder:text-surface-500',
                )}
              />
            </div>
          )}
          <ul ref={listRef} id={listboxId} role="listbox" className="max-h-64 overflow-auto py-1">
            {visible.length === 0 && (
              <li className="px-3 py-2 text-sm text-surface-400 dark:text-surface-500">
                No matches
              </li>
            )}
            {visible.map((opt, index) => (
              // Listbox options take pointer, not keyboard, interaction — the
              // trigger button (or search box) keeps focus and owns all key
              // handling above.
              <li
                key={opt.value}
                role="option"
                aria-selected={opt.value === value}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => commit(index)}
                className={cn(
                  'px-3 py-2 text-sm cursor-pointer flex items-center justify-between gap-2',
                  index === activeIndex ? 'bg-surface-100 dark:bg-surface-700' : 'bg-transparent',
                  opt.value === value
                    ? 'font-medium text-primary-600 dark:text-primary-400'
                    : 'text-surface-700 dark:text-surface-200',
                )}
              >
                <span className="truncate">{opt.label}</span>
                {opt.value === value && <Check className="w-3.5 h-3.5 shrink-0" />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
