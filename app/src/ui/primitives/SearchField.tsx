import { forwardRef, useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { Input, type InputProps } from './Input';

export interface SearchFieldProps extends Omit<InputProps, 'value' | 'onChange' | 'type'> {
  value: string;
  onValueChange: (value: string) => void;
  /**
   * Milliseconds to wait before reporting a change.
   *
   * The field itself always updates immediately — only the reported value is
   * delayed — so typing never feels laggy while a 200-row list stops re-sorting
   * and re-rendering on every keystroke.
   */
  debounceMs?: number;
  /** Required: the field's accessible name, e.g. "Search leads". */
  label: string;
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onValueChange, debounceMs = 200, label, className, ...props },
  ref,
) {
  const [draft, setDraft] = useState(value);

  // Re-sync when the parent clears or replaces the query — a "clear filters"
  // button, or a saved view being applied.
  useEffect(() => setDraft(value), [value]);

  useEffect(() => {
    if (draft === value) return;
    const id = window.setTimeout(() => onValueChange(draft), debounceMs);
    return () => window.clearTimeout(id);
    // `value` is deliberately absent from the deps: including it restarts the
    // timer when the parent echoes the value back, which never settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, debounceMs, onValueChange]);

  return (
    <Input
      ref={ref}
      type="search"
      aria-label={label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      leading={<Search aria-hidden className="h-3.5 w-3.5" />}
      trailing={
        draft ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setDraft('');
              onValueChange('');
            }}
            className="rounded-xs p-0.5 text-text-tertiary transition-colors hover:text-text-primary"
          >
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        ) : undefined
      }
      className={cn('bg-surface', className)}
      {...props}
    />
  );
});
