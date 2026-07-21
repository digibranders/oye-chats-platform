import { cn } from '../lib/cn';

export interface ProgressProps {
  /** Completion 0–100. */
  value: number;
  /** Accessible name for the bar (announced by screen readers). */
  label?: string;
  className?: string;
}

/** Progress — a determinate horizontal progress bar. */
export function Progress({ value, label, className }: ProgressProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]', className)}
    >
      <div
        className="h-full rounded-full bg-[var(--ds-accent)] transition-[width] duration-500"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
