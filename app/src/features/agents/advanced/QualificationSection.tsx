import { type ReactElement, useState } from 'react';
import { Target, SlidersHorizontal } from 'lucide-react';
import { Card, SectionHeader, StatusBadge, Button, Select } from '../../../design-system';
import { FRAMEWORK_OPTIONS, readThresholds } from './advanced.config';
import { QualificationEditor } from './QualificationEditor';

interface QualificationSectionProps {
  framework: string;
  bantConfig: Record<string, unknown> | null;
  onFrameworkChange: (key: string) => void;
  /** Commit an edited `bant_config` back to the page draft. */
  onBantConfigChange: (config: Record<string, unknown>) => void;
}

/**
 * Lead qualification — which framework scores visitors as leads. Switching the
 * framework applies its preset scoring model (handled by the page). Per-dimension
 * weight/threshold editing lives in the dedicated qualification editor (surfaced
 * to the user by the Info card below) — this surface owns the framework choice
 * plus a read-only threshold summary.
 */
export function QualificationSection({
  framework,
  bantConfig,
  onFrameworkChange,
  onBantConfigChange,
}: QualificationSectionProps): ReactElement {
  const [editorOpen, setEditorOpen] = useState(false);
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
          <Select
            id="qualification-framework"
            value={framework}
            onChange={onFrameworkChange}
            options={FRAMEWORK_OPTIONS.map((option) => ({
              value: option.key,
              label: option.label,
            }))}
          />
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

        {/* Fine-grained scoring opens in a focused editor so the heavy config
            model doesn't crowd this page. Applying there marks the page dirty;
            the page's save bar persists it. */}
        <div className="flex flex-col gap-3 rounded-lg bg-[var(--ds-bg-sunken)] p-3.5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12px] leading-relaxed text-[var(--ds-text-muted)]">
            Tune dimension weights and options, tier thresholds, score decay, and behavioural
            scoring. Choosing a framework above sets the starting point.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setEditorOpen(true)}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            Edit scoring model
          </Button>
        </div>
      </Card>

      <QualificationEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        framework={framework}
        config={bantConfig}
        onApply={onBantConfigChange}
      />
    </section>
  );
}
