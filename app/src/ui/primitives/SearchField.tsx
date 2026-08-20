import { forwardRef, useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { Input, type InputProps } from './Input';
import { CONTROL_SIZE } from './controlStyles';
import { useField } from './fieldContext';

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

/**
 * A debounced query box with one clear button.
 *
 * One, not two: `type="search"` makes Chrome and Safari draw their own clear
 * affordance, so until `CONTROL_BASE` reset it the field showed two X's 20px
 * apart on every table toolbar in the console.
 *
 * The clear button is always rendered and merely hidden while the field is
 * empty. Toggling the slot in and out toggled the field's trailing padding with
 * it, so the first keystroke narrowed the content box by 36px and jumped the
 * caret on any query longer than the field.
 */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onValueChange, debounceMs = 200, label, size = 'md', className, ...props },
  ref,
) {
  const [draft, setDraft] = useState(value);
  const field = useField();

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
      size={size}
      // Inside a `Field` the visible label already names it, and `aria-label`
      // would win the name computation and replace it.
      aria-label={field ? undefined : label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      leading={<Search aria-hidden className={CONTROL_SIZE[size].icon} />}
      trailing={
        <button
          type="button"
          aria-label="Clear search"
          // Out of the tab order while there is nothing to clear, so a keyboard
          // user does not tab onto an invisible control.
          tabIndex={draft ? 0 : -1}
          onClick={() => {
            setDraft('');
            onValueChange('');
          }}
          // 24px, not the 18px it shipped at. A control inside a 34px field
          // cannot claim SC 2.5.8's spacing exception.
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-xs text-text-tertiary',
            'transition-colors duration-[var(--dur-fast)] hover:bg-surface-hover hover:text-text-primary',
            !draft && 'invisible',
          )}
        >
          <X aria-hidden className="h-icon-sm w-icon-sm" />
        </button>
      }
      className={cn('bg-surface', className)}
      {...props}
    />
  );
});
