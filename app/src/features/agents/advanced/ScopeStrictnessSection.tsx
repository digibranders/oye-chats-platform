import { type KeyboardEvent, type ReactElement, useRef } from 'react';
import { Shield } from 'lucide-react';
import { SectionHeader, cn } from '../../../design-system';
import {
  STRICTNESS_LEVELS,
  DEFAULT_RELEVANCE_THRESHOLD,
  matchesLevel,
} from './advanced.config';

interface ScopeStrictnessSectionProps {
  /** null = platform default. */
  value: number | null;
  onChange: (next: number | null) => void;
}

/**
 * Answering scope — how strictly the agent stays within your knowledge base.
 * A 3-option radiogroup bound to the reused `relevance_threshold` Bot field,
 * with full WAI-ARIA radio semantics (roving tabindex + arrow-key nav).
 */
export function ScopeStrictnessSection({
  value,
  onChange,
}: ScopeStrictnessSectionProps): ReactElement {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectedIndex = STRICTNESS_LEVELS.findIndex((level) => matchesLevel(value, level.value));
  // A saved value that matches no preset (a legacy hand-set threshold) leaves no
  // radio checked; keyboard focus still lands on Balanced so the group stays
  // reachable via the roving tabindex.
  const focusIndex = selectedIndex >= 0 ? selectedIndex : 1;
  const isOffPreset = selectedIndex < 0 && value !== null;
  const isDefault = value === null;

  function selectAt(index: number): void {
    const level = STRICTNESS_LEVELS[index];
    if (!level) return;
    buttonRefs.current[index]?.focus();
    onChange(level.value);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    const count = STRICTNESS_LEVELS.length;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      selectAt((focusIndex + 1) % count);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      selectAt((focusIndex - 1 + count) % count);
    }
  }

  return (
    <section aria-labelledby="scope-heading" className="space-y-4">
      <SectionHeader
        title={
          <span id="scope-heading" className="inline-flex items-center gap-2">
            <Shield size={15} className="text-[var(--ds-accent)]" aria-hidden="true" />
            Answering scope
          </span>
        }
        description="How strictly your agent stays within what it has learned. Loosen it if real questions get turned away; tighten it to keep answers locked to your content."
      />

      <div
        role="radiogroup"
        aria-label="Answering scope strictness"
        className="grid grid-cols-1 gap-3 md:grid-cols-3"
      >
        {STRICTNESS_LEVELS.map((level, index) => {
          const checked = index === selectedIndex;
          const focusable = index === focusIndex;
          return (
            <button
              key={level.value}
              ref={(node) => {
                buttonRefs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={focusable ? 0 : -1}
              onClick={() => onChange(level.value)}
              onKeyDown={handleKeyDown}
              className={cn(
                'rounded-xl border p-4 text-left transition-colors',
                'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                checked
                  ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]'
                  : 'border-[var(--ds-border)] bg-[var(--ds-bg-surface)] hover:border-[var(--ds-text-subtle)]',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[14px] font-semibold text-[var(--ds-text)]">
                  {level.label}
                </span>
                {isDefault && level.value === DEFAULT_RELEVANCE_THRESHOLD && (
                  <span className="text-[10px] font-bold uppercase tracking-wide text-[var(--ds-text-subtle)]">
                    Default
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--ds-text-muted)]">
                {level.help}
              </p>
            </button>
          );
        })}
      </div>

      {isOffPreset && value !== null && (
        <p className="text-[12px] leading-relaxed text-[var(--ds-text-muted)]" role="status">
          This agent uses a custom strictness of{' '}
          <span className="font-semibold text-[var(--ds-text)]">{value.toFixed(2)}</span>, which
          doesn’t match a preset. Pick a level above to change it, or reset to the platform default.
        </p>
      )}

      {!isDefault && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-[12px] font-medium text-[var(--ds-text-muted)] underline underline-offset-2 transition-colors hover:text-[var(--ds-text)]"
        >
          Reset to platform default
        </button>
      )}
    </section>
  );
}
