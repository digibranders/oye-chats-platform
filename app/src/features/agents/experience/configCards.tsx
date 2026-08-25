/**
 * The chrome every bot-config card is built from: the bordered panel, the
 * per-card save footer with its own dirty/saving/saved/error state, the switch,
 * the labelled switch row, and the labelled text field.
 *
 * Extracted from `BotConfigSection` so cards can live in their own files
 * without importing back into the section that renders them. Purely
 * presentational: nothing here loads, saves, or knows what a `Bot` is.
 */
import { type ReactElement, type ReactNode, useId } from 'react';
import { Check, Lock } from 'lucide-react';
import { Button, Input, cn } from '../../../design-system';
import { type SliceStatus } from './botConfig';

export function Card({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="space-y-5 rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5">
      {children}
    </div>
  );
}

export function SaveFooter({
  dirty,
  status,
  onSave,
  label,
}: {
  dirty: boolean;
  status: SliceStatus;
  onSave: () => void;
  label: string;
}): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[var(--ds-border)] pt-4">
      <p role="status" aria-live="polite" className="min-w-0 truncate text-[12px]">
        {status.error ? (
          <span className="text-[var(--ds-danger)]">{status.error}</span>
        ) : status.saving ? (
          <span className="text-[var(--ds-text-muted)]">Saving…</span>
        ) : status.saved && !dirty ? (
          <span className="inline-flex items-center gap-1 text-[var(--ds-success)]">
            <Check size={13} aria-hidden="true" /> Saved
          </span>
        ) : dirty ? (
          <span className="text-[var(--ds-text-muted)]">Unsaved changes</span>
        ) : (
          <span className="text-[var(--ds-text-subtle)]">Up to date</span>
        )}
      </p>
      <Button size="sm" onClick={onSave} disabled={!dirty || status.saving}>
        {status.saving ? 'Saving…' : label}
      </Button>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
        checked ? 'bg-[var(--ds-accent)]' : 'bg-[var(--ds-border)]',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

export function ToggleRow({
  title,
  description,
  checked,
  onChange,
  disabled = false,
  disabledReason,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /**
   * Why the switch cannot be used right now. Shown in place of nothing:
   * a control that is dimmed with no explanation reads as a bug.
   */
  disabledReason?: string;
}): ReactElement {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 rounded-[var(--ds-radius-lg)] border px-4 py-3',
        'border-[var(--ds-border)] bg-[var(--ds-bg-sunken)]',
        disabled && 'opacity-60',
      )}
    >
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-[var(--ds-text)]">{title}</p>
        <p className="mt-0.5 text-[12px] text-[var(--ds-text-muted)]">{description}</p>
        {disabled && disabledReason && (
          <p className="mt-1 text-[11px] text-[var(--ds-text-subtle)]">{disabledReason}</p>
        )}
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} disabled={disabled} />
    </div>
  );
}

export function TextField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  maxLength,
  disabled,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  maxLength?: number;
  disabled?: boolean;
}): ReactElement {
  const id = useId();
  const hintId = useId();
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={id}
        className={cn(
          'flex items-center gap-1.5 text-[13px] font-medium',
          disabled ? 'text-[var(--ds-text-subtle)]' : 'text-[var(--ds-text)]',
        )}
      >
        {disabled && <Lock size={11} strokeWidth={1.75} aria-hidden="true" />}
        {label}
      </label>
      <Input
        id={id}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && (
        <p id={hintId} className="text-[11px] text-[var(--ds-text-subtle)]">
          {hint}
        </p>
      )}
    </div>
  );
}

