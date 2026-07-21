import { type ReactElement } from 'react';
import { Target, ChevronDown, Info } from 'lucide-react';
import { Card, SectionHeader, StatusBadge, cn } from '../../../design-system';
import { FRAMEWORK_OPTIONS, readThresholds } from './advanced.config';

interface QualificationSectionProps {
  framework: string;
  bantConfig: Record<string, unknown> | null;
  onFrameworkChange: (key: string) => void;
}

/**
 * Lead qualification — which framework scores visitors as leads. Switching the
 * framework applies its preset scoring model (handled by the page). Per-dimension
 * weight/threshold editing is intentionally deferred to a dedicated editor
 * (see TODO) — this surface owns the framework choice + a read-only summary.
 */
export function QualificationSection({
  framework,
  bantConfig,
  onFrameworkChange,
}: QualificationSectionProps): ReactElement {
  const thresholds = readThresholds(bantConfig);
  const isCustom = framework === 'custom';

  return (
    <section aria-labelledby="qualification-heading" className="space-y-4">
      <SectionHeader
        title={
          <span id="qualification-heading" className="inline-flex items-center gap-2">
            <Target size={15} className="text-[var(--ds-accent)]" aria-hidden="true" />
            Lead qualification
          </span>
        }
        description="The method your agent uses to score visitors as leads while it chats with them."
      />

      <Card className="space-y-5 p-5">
        <div className="max-w-sm space-y-1.5">
          <label
            htmlFor="qualification-framework"
            className="block text-[13px] font-medium text-[var(--ds-text)]"
          >
            Scoring framework
          </label>
          <div className="relative">
            <select
              id="qualification-framework"
              value={framework}
              onChange={(event) => onFrameworkChange(event.target.value)}
              className={cn(
                'h-10 w-full appearance-none rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] pl-3 pr-9 text-sm text-[var(--ds-text)] outline-none transition-colors',
                'focus-visible:border-[var(--ds-accent)] focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-soft)]',
              )}
            >
              {FRAMEWORK_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDown
              size={16}
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--ds-text-subtle)]"
            />
          </div>
          <p className="text-[12px] leading-relaxed text-[var(--ds-text-subtle)]">
            {isCustom
              ? 'Custom keeps your existing dimensions and lets you tailor scoring in the detailed editor.'
              : 'Switching applies this framework’s recommended scoring model.'}
          </p>
        </div>

        {/* Read-only summary of the tier thresholds this framework promotes at. */}
        {thresholds && (
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
              Qualification thresholds
            </p>
            <div className="flex flex-wrap gap-2">
              <StatusBadge tone="accent">MQL at {thresholds.mql}</StatusBadge>
              <StatusBadge tone="warning">SAL at {thresholds.sal}</StatusBadge>
              <StatusBadge tone="success">SQL at {thresholds.sql}</StatusBadge>
            </div>
          </div>
        )}

        {/* TODO(agents/advanced): full per-dimension weight/threshold/decay editor
            (see pages/Qualification.jsx ConfigurationTab) belongs in a dedicated
            surface. This section wires the framework choice only. */}
        <div className="flex items-start gap-2.5 rounded-lg bg-[var(--ds-bg-sunken)] p-3.5">
          <Info size={15} className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]" aria-hidden="true" />
          <p className="text-[12px] leading-relaxed text-[var(--ds-text-muted)]">
            Fine-grained scoring — dimension weights, tier thresholds and score decay — is edited in
            the dedicated qualification editor. Choosing a framework here sets the starting point.
          </p>
        </div>
      </Card>
    </section>
  );
}
