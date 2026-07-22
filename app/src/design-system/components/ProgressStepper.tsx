import { Check } from 'lucide-react';
import { cn } from '../lib/cn';

export interface StepperItem {
  key: string;
  label: string;
  description?: string;
}

export interface ProgressStepperProps {
  steps: StepperItem[];
  /** Index of the step currently being shown. */
  currentIndex: number;
  /** Furthest step the user has legitimately reached (enables back-nav to it). */
  maxReachedIndex: number;
  /** Navigate to a step (only invoked for reachable steps). */
  onStepClick?: (index: number) => void;
  /** Accessible name for the progress navigation. */
  ariaLabel?: string;
  className?: string;
}

type StepState = 'done' | 'current' | 'reachable' | 'locked';

function stepState(index: number, currentIndex: number, maxReachedIndex: number): StepState {
  if (index === currentIndex) return 'current';
  if (index < currentIndex || index <= maxReachedIndex) return index < currentIndex ? 'done' : 'reachable';
  return 'locked';
}

/**
 * ProgressStepper — vertical multi-step progress rail (mandate shared
 * component). Shows done / current / reachable / locked states and lets the
 * user jump back to any already-reached step. Used by Launch Studio and any
 * future guided flow.
 */
export function ProgressStepper({
  steps,
  currentIndex,
  maxReachedIndex,
  onStepClick,
  ariaLabel = 'Progress',
  className,
}: ProgressStepperProps) {
  return (
    <nav aria-label={ariaLabel}>
      <ol className={cn('flex flex-col gap-1', className)}>
        {steps.map((step, index) => {
          const state = stepState(index, currentIndex, maxReachedIndex);
          const isDone = state === 'done';
          const isCurrent = state === 'current';
          const isLocked = state === 'locked';
          const clickable = !isLocked && !isCurrent && Boolean(onStepClick);
          const isLast = index === steps.length - 1;

          return (
            <li key={step.key} className="relative">
              <button
                type="button"
                aria-current={isCurrent ? 'step' : undefined}
                aria-disabled={isLocked || undefined}
                onClick={clickable ? () => onStepClick?.(index) : undefined}
                className={cn(
                'group flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors',
                clickable && 'hover:bg-[var(--ds-bg-hover)]',
                isCurrent && 'bg-[var(--ds-accent-soft)]',
                !clickable && !isCurrent && 'cursor-default',
              )}
            >
              {/* Marker + connector */}
              <span className="relative flex flex-col items-center">
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors',
                    isDone && 'border-[var(--ds-accent)] bg-[var(--ds-accent)] text-[var(--ds-accent-fg)]',
                    isCurrent && 'border-[var(--ds-accent)] text-[var(--ds-accent-text)]',
                    isLocked && 'border-[var(--ds-border)] text-[var(--ds-text-subtle)]',
                    state === 'reachable' && 'border-[var(--ds-border-strong)] text-[var(--ds-text-muted)]',
                  )}
                >
                  {isDone ? <Check size={13} strokeWidth={3} /> : index + 1}
                </span>
                {!isLast && (
                  <span
                    className={cn(
                      'mt-1 h-6 w-px',
                      index < currentIndex ? 'bg-[var(--ds-accent)]' : 'bg-[var(--ds-border)]',
                    )}
                  />
                )}
              </span>

              <span className="min-w-0 pt-0.5">
                <span
                  className={cn(
                    'block truncate text-[13px] font-medium',
                    isCurrent ? 'text-[var(--ds-accent-text)]' : isLocked ? 'text-[var(--ds-text-subtle)]' : 'text-[var(--ds-text)]',
                  )}
                >
                  {step.label}
                </span>
                {step.description && (
                  <span className="mt-0.5 block truncate text-[11px] text-[var(--ds-text-subtle)]">
                    {step.description}
                  </span>
                )}
              </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
