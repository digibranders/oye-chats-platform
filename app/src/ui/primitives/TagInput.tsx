import { useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';
import { CONTROL_BASE } from './Input';
import { useFieldControlProps } from './fieldContext';

export interface TagInputProps {
  values: readonly string[];
  onValuesChange: (values: string[]) => void;
  /** Required: the control's accessible name, e.g. "Notification recipients". */
  label: string;
  placeholder?: string;
  /**
   * Reject a value and say why. Return `null` to accept.
   *
   * Returning the reason rather than a boolean is what lets the control explain
   * the specific failure — the previous email-chips input had a single shared
   * error slot that any keystroke cleared, so pasting five addresses surfaced
   * only the first problem and then hid it.
   */
  validate?: (value: string) => string | null;
  /** Normalise before storing, e.g. lowercase an email. */
  normalize?: (value: string) => string;
  maxValues?: number;
  disabled?: boolean;
  className?: string;
}

const SEPARATORS = /[,;\s]+/;

/**
 * A list of short values built by typing.
 *
 * Commits on Enter, Tab, comma, semicolon and blur, and accepts a pasted list in
 * one go. Backspace on an empty field removes the last chip, which is the
 * behaviour every mail client has trained people to expect.
 *
 * Errors accumulate per rejected value and clear only when that value is retried
 * or dismissed, so a paste of ten addresses reports every bad one.
 */
export function TagInput({
  values,
  onValuesChange,
  label,
  placeholder,
  validate,
  normalize,
  maxValues,
  disabled = false,
  className,
}: TagInputProps) {
  const [draft, setDraft] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const fieldProps = useFieldControlProps();

  function commit(raw: string) {
    const candidates = raw.split(SEPARATORS).map((part) => part.trim()).filter(Boolean);
    if (candidates.length === 0) return;

    const problems: string[] = [];
    const next = [...values];

    for (const candidate of candidates) {
      const normalized = normalize ? normalize(candidate) : candidate;
      if (next.includes(normalized)) {
        problems.push(`${normalized} is already in the list.`);
        continue;
      }
      if (maxValues && next.length >= maxValues) {
        problems.push(`Only ${maxValues} allowed.`);
        break;
      }
      const failure = validate?.(normalized);
      if (failure) {
        problems.push(failure);
        continue;
      }
      next.push(normalized);
    }

    setErrors(problems);
    setDraft('');
    if (next.length !== values.length) onValuesChange(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
      event.preventDefault();
      commit(draft);
      return;
    }
    if (event.key === 'Tab' && draft.trim()) {
      // Commit but let focus move on: interrupting Tab to keep the user in the
      // field is the kind of trap that makes a form feel hostile.
      commit(draft);
      return;
    }
    if (event.key === 'Backspace' && draft === '' && values.length > 0) {
      onValuesChange(values.slice(0, -1));
    }
  }

  return (
    <div className={className}>
      <div
        className={cn(
          CONTROL_BASE,
          'flex min-h-control-md flex-wrap items-center gap-1.5 px-2 py-1.5',
          disabled && 'cursor-not-allowed bg-surface-sunken',
        )}
      >
        {values.map((item) => (
          <span
            key={item}
            className="inline-flex items-center gap-1 rounded-xs bg-surface-sunken py-0.5 pl-2 pr-1 text-xs text-text-primary"
          >
            {item}
            <button
              type="button"
              disabled={disabled}
              aria-label={`Remove ${item}`}
              onClick={() => onValuesChange(values.filter((candidate) => candidate !== item))}
              className="rounded-xs p-0.5 text-text-tertiary transition-colors hover:text-danger"
            >
              <X aria-hidden className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          type="text"
          aria-label={label}
          value={draft}
          disabled={disabled}
          placeholder={values.length === 0 ? placeholder : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text');
            if (SEPARATORS.test(text)) {
              event.preventDefault();
              commit(text);
            }
          }}
          className="min-w-[8rem] flex-1 bg-transparent text-base text-text-primary outline-none placeholder:text-text-disabled"
          {...fieldProps}
        />
      </div>

      {errors.length > 0 ? (
        <ul role="status" aria-live="polite" className="mt-1.5 space-y-0.5 text-xs text-danger">
          {errors.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
