import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';
import { CONTROL_BASE } from './Input';
import { CONTROL_SIZE, FOCUS_RING, HIT_AREA } from './controlStyles';
import { useField, useFieldControlProps } from './fieldContext';

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
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
}

const SEPARATORS = /[,;\s]+/;

/**
 * The wrapper and the input each take half of the control's text inset, so the
 * placeholder lands on the same column as a chip's first letter and as the text
 * of an `Input` stacked above it. The wrapper was `px-2` against every other
 * `md` control's 12, which put the placeholder 4px to the left of the field
 * above it in the same form.
 */
const SHELL_PAD = { sm: 'px-1 py-1', md: 'px-1.5 py-1.5' } as const;

/**
 * A list of short values built by typing.
 *
 * Commits on Enter, Tab, comma, semicolon and blur, and accepts a pasted list in
 * one go. Backspace on an empty field removes the last chip, which is the
 * behaviour every mail client has trained people to expect.
 *
 * Errors accumulate per rejected value and clear only when that value is retried
 * or dismissed, so a paste of ten addresses reports every bad one.
 *
 * The focus ring is drawn on the box, not on the input. The inner input carries
 * `outline-none` — which it must, or the ring would be painted around a bare
 * text run inside the chips — and `outline-style: none` at normal specificity
 * beats the zero-specificity global rule in `tokens.css`. So tabbing into this
 * control showed **nothing at all**: an SC 2.4.7 failure on a shipped control,
 * and exactly the class of defect DESIGN.md §5 exists to prevent.
 */
export function TagInput({
  values,
  onValuesChange,
  label,
  placeholder,
  validate,
  normalize,
  maxValues,
  size = 'md',
  disabled = false,
  className,
}: TagInputProps) {
  const [draft, setDraft] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const field = useField();
  const fieldProps = useFieldControlProps();
  const inputRef = useRef<HTMLInputElement>(null);
  const errorsId = useId();
  const geometry = CONTROL_SIZE[size];
  const isDisabled = disabled || Boolean(fieldProps.disabled);

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

  const describedBy =
    [errors.length > 0 ? errorsId : undefined, fieldProps['aria-describedby'] as string | undefined]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className={className}>
      <div
        // With wrapped chips the second row's trailing whitespace is dead space;
        // every mail client focuses the field on a click anywhere in the box.
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault();
            inputRef.current?.focus();
          }
        }}
        className={cn(
          CONTROL_BASE,
          FOCUS_RING,
          'flex flex-wrap items-center gap-1.5',
          size === 'sm' ? 'min-h-control-sm' : 'min-h-control-md',
          geometry.radius,
          SHELL_PAD[size],
          // `enabled:` cannot match a div, so the hover is decided here.
          isDisabled ? 'cursor-not-allowed bg-surface-sunken' : 'hover:border-text-tertiary',
        )}
      >
        {values.map((item) => (
          <span
            key={item}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-xs border pl-2 pr-1 text-xs',
              // A chip was `bg-surface-sunken` with no border on a white field —
              // 4.5 L* for its whole boundary — and when the field was disabled
              // the two were literally the same colour, so the values vanished.
              // Disabled inverts the pair instead of dimming either.
              isDisabled
                ? 'border-border bg-surface text-text-disabled'
                : 'border-border bg-surface-sunken text-text-primary',
            )}
          >
            {item}
            <button
              type="button"
              disabled={isDisabled}
              aria-label={`Remove ${item}`}
              onClick={() => onValuesChange(values.filter((candidate) => candidate !== item))}
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-tertiary',
                'transition-colors duration-[var(--dur-fast)] hover:bg-danger-tint hover:text-danger',
                'disabled:cursor-not-allowed disabled:text-text-disabled disabled:hover:bg-transparent',
                // 20px of glyph in a 24px target: this is the destructive
                // control in the component and it shipped at 16 × 16.
                HIT_AREA,
              )}
            >
              <X aria-hidden className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          // Only outside a `Field`: inside one the visible label already names
          // the control, and `aria-label` would replace it.
          aria-label={field ? undefined : label}
          value={draft}
          disabled={isDisabled}
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
          className={cn(
            'min-w-[8rem] flex-1 bg-transparent px-1.5 text-text-primary outline-none placeholder:text-text-disabled',
            geometry.text,
          )}
          {...fieldProps}
          aria-describedby={describedBy}
        />
      </div>

      {errors.length > 0 ? (
        // `aria-live` on the list itself. `role="status"` replaced the list
        // semantics the markup had just built, so a screen reader announced a
        // run-on sentence instead of "list, three items".
        <ul id={errorsId} aria-live="polite" className="mt-1.5 space-y-0.5 text-xs text-danger">
          {errors.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
